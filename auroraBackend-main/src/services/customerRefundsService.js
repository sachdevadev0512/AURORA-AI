/**
 * Customer refund sync from Amazon Finances.
 *
 * Why this exists (in addition to customerReturnsService):
 * The FBA Customer Returns report only lists returns after a unit is physically
 * received and processed at a fulfillment center. Amazon issues plenty of refunds
 * that never appear there — returnless refunds, concessions, or refunds granted
 * before the unit is received. Seller Central's order view shows those as
 * "Refund applied", so Aurora must read refund events to match it.
 *
 * Primary source: Finances API v2024-06-19 `listTransactions` (Refund rows).
 * This includes DEFERRED refunds that Seller Central already shows as
 * "Refund applied" but which Finances v0 `RefundEventList` still omits until
 * RELEASED — the main lag that left Return Proc at $0.
 *
 * Secondary: Finances v0 `RefundEventList` (released/settled refunds).
 */
const Order = require('../models/Order');
const User = require('../models/User');

const SYNC_COOLDOWN_MS = parseInt(
  process.env.REFUNDS_SYNC_COOLDOWN_MS || String(30 * 60 * 1000),
  10,
);
/**
 * How far back scheduled / live refund sync walks Finances events.
 * 90d keeps recent deferred refunds covered without multi-hour walks per seller.
 * One-time historical catch-up: `node scripts/backfill-customer-refunds.js` (180d).
 */
const REFUNDS_LOOKBACK_DAYS = parseInt(process.env.REFUNDS_LOOKBACK_DAYS || '90', 10);
/**
 * Cap pages per date-chunk (not the whole lookback). Finances mixes shipment/
 * fee/adjustment events with refunds, so a single open-ended walk from 120d
 * ago hits the page cap before reaching recent refunds. Chunking newest-first
 * guarantees recent "Refund applied" orders are captured first.
 */
const REFUNDS_MAX_PAGES_PER_CHUNK = parseInt(process.env.REFUNDS_MAX_PAGES || '80', 10);
/** Width of each Finances window. Must stay well under Amazon's 180-day cap. */
const REFUNDS_CHUNK_DAYS = parseInt(process.env.REFUNDS_CHUNK_DAYS || '14', 10);
/** Max listTransactions pages per refund sync (500 txs/page). */
const REFUNDS_TX_MAX_PAGES = parseInt(process.env.REFUNDS_TX_MAX_PAGES || '80', 10);

function money(chargeAmount) {
  const v = Number(chargeAmount?.CurrencyAmount);
  return Number.isFinite(v) ? v : 0;
}

function maxDate(...dates) {
  let best = null;
  for (const value of dates) {
    if (!value) continue;
    const ts = new Date(value).getTime();
    if (!Number.isFinite(ts)) continue;
    if (best == null || ts > best.getTime()) best = new Date(ts);
  }
  return best;
}

/** Extract per-SKU refund lines from a single Finances v0 RefundEvent. */
function parseRefundEvent(event) {
  const amazonOrderId = event?.AmazonOrderId;
  if (!amazonOrderId) return null;

  const postedDate = event.PostedDate ? new Date(event.PostedDate) : null;
  const adjustments = event.ShipmentItemAdjustmentList || event.ShipmentItemList || [];
  const lines = [];

  for (const item of adjustments) {
    const sku = item?.SellerSKU || null;
    // Principal is the product price refunded to the buyer (stored as a negative
    // amount on a refund); tax/fees are excluded so this matches the item subtotal.
    const principal = (item?.ItemChargeAdjustmentList || item?.ItemChargeList || []).find(
      (c) => c?.ChargeType === 'Principal',
    );
    const amount = Math.abs(money(principal?.ChargeAmount));
    const rawQty = Number(item?.QuantityShipped);
    const quantity = Number.isFinite(rawQty) && rawQty !== 0 ? Math.abs(Math.round(rawQty)) : 1;

    // Skip pure fee/tax adjustment rows that carry no product identity or value.
    if (!sku && amount === 0) continue;

    lines.push({
      refundDate: postedDate,
      sku,
      asin: null,
      productName: null,
      quantity,
      amount,
      currency: principal?.ChargeAmount?.CurrencyCode || null,
      marketplaceName: event.MarketplaceName || null,
      source: 'finances_v0',
    });
  }

  if (lines.length === 0) return null;
  return { amazonOrderId, refunds: lines };
}

function relatedIdentifierValue(tx, ...names) {
  const want = new Set(names.map((n) => String(n).toUpperCase()));
  for (const r of tx?.relatedIdentifiers || []) {
    const name = String(r.relatedIdentifierName || '').toUpperCase();
    if (want.has(name) && r.relatedIdentifierValue) {
      return String(r.relatedIdentifierValue).trim();
    }
  }
  return '';
}

function walkBreakdownAmount(node, needle, acc = { amount: 0, currency: null }) {
  if (!node) return acc;
  const list = Array.isArray(node) ? node : [node];
  for (const b of list) {
    if (!b || typeof b !== 'object') continue;
    const type = String(b.breakdownType || '');
    if (type.toLowerCase() === needle.toLowerCase()) {
      const amt = Number(b.breakdownAmount?.currencyAmount);
      if (Number.isFinite(amt)) {
        acc.amount += amt;
        if (!acc.currency && b.breakdownAmount?.currencyCode) {
          acc.currency = b.breakdownAmount.currencyCode;
        }
      }
    }
    if (b.breakdowns) walkBreakdownAmount(b.breakdowns, needle, acc);
  }
  return acc;
}

/**
 * Extract per-SKU refund lines from Finances v2024 listTransactions Refund rows.
 * Captures DEFERRED refunds that Seller Central already labels "Refund applied"
 * but which v0 RefundEventList does not return yet.
 *
 * Multiple item rows for the same SKU inside one Refund transaction (partial
 * multi-unit refunds) are summed so returned_units matches Seller Central.
 */
function parseRefundTransaction(tx) {
  const type = String(tx?.transactionType || '').toLowerCase();
  if (type !== 'refund' && type !== 'chargerefund') return null;

  const amazonOrderId = relatedIdentifierValue(tx, 'ORDER_ID');
  if (!amazonOrderId) return null;

  const refundId = relatedIdentifierValue(tx, 'REFUND_ID') || null;
  const postedDate = tx.postedDate ? new Date(tx.postedDate) : null;
  const bySku = new Map();

  for (const item of tx.items || []) {
    const ctx = (item.contexts || []).find(
      (c) => String(c?.contextType || '') === 'ProductContext',
    ) || (item.contexts || [])[0] || {};
    const sku = (ctx.sku || '').trim() || null;
    const asin = (ctx.asin || '').trim() || null;
    const rawQty = Number(ctx.quantityShipped);
    const quantity = Number.isFinite(rawQty) && rawQty !== 0
      ? Math.abs(Math.round(rawQty))
      : 1;

    const principal = walkBreakdownAmount(item.breakdowns, 'OurPricePrincipal');
    let amount = Math.abs(principal.amount);
    let currency = principal.currency;
    if (!(amount > 0)) {
      const product = walkBreakdownAmount(item.breakdowns, 'ProductCharges');
      amount = Math.abs(product.amount);
      currency = currency || product.currency;
    }
    if (!(amount > 0)) {
      amount = Math.abs(Number(item?.totalAmount?.currencyAmount) || 0);
      currency = currency || item?.totalAmount?.currencyCode || null;
    }

    // Fee-only / $0 adjustment rows still carry ProductContext.quantityShipped
    // from the original order (e.g. qty 6). Counting them as refunded units
    // doubles Return Proc when Amazon also posts a separate product refund.
    if (!(amount > 0)) continue;

    if (!sku && !(amount > 0)) continue;

    const key = sku || asin || `anon:${bySku.size}`;
    const prev = bySku.get(key);
    if (prev) {
      prev.quantity += quantity;
      prev.amount = Math.round((prev.amount + amount) * 100) / 100;
      if (!prev.asin && asin) prev.asin = asin;
      if (!prev.productName && item.description) prev.productName = item.description;
    } else {
      bySku.set(key, {
        refundDate: postedDate,
        sku,
        asin,
        productName: item.description || null,
        quantity,
        amount: Math.round(amount * 100) / 100,
        currency: currency || tx?.totalAmount?.currencyCode || null,
        marketplaceName: tx?.marketplaceDetails?.marketplaceName || null,
        source: 'list_transactions',
        transactionStatus: tx.transactionStatus || null,
        refundId,
      });
    }
  }

  // Some refund txs only carry a header total with no item breakdown.
  if (bySku.size === 0) {
    const amount = Math.abs(Number(tx?.totalAmount?.currencyAmount) || 0);
    if (!(amount > 0)) return null;
    bySku.set('header', {
      refundDate: postedDate,
      sku: null,
      asin: null,
      productName: tx.description || null,
      quantity: 1,
      amount: Math.round(amount * 100) / 100,
      currency: tx?.totalAmount?.currencyCode || null,
      marketplaceName: tx?.marketplaceDetails?.marketplaceName || null,
      source: 'list_transactions',
      transactionStatus: tx.transactionStatus || null,
      refundId,
    });
  }

  return { amazonOrderId, refunds: [...bySku.values()] };
}

function pushGroupedRefund(grouped, parsed) {
  if (!parsed?.amazonOrderId || !parsed.refunds?.length) return;
  if (!grouped.has(parsed.amazonOrderId)) grouped.set(parsed.amazonOrderId, []);
  grouped.get(parsed.amazonOrderId).push(...parsed.refunds);
}

function financesPostedBefore(d = new Date()) {
  return new Date(d.getTime() - 3 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function latestRefundDate(refunds = []) {
  let latest = null;
  for (const row of refunds) {
    const ts = row?.refundDate ? new Date(row.refundDate).getTime() : NaN;
    if (!Number.isFinite(ts)) continue;
    if (latest == null || ts > latest.getTime()) latest = new Date(ts);
  }
  return latest;
}

/** Stable key so overlapping sync windows merge instead of wiping older refunds. */
function refundRowKey(row = {}) {
  const dateIso = row.refundDate ? new Date(row.refundDate).toISOString() : '';
  return [
    dateIso,
    row.sku || '',
    row.quantity ?? '',
    row.amount ?? '',
    row.currency || '',
    row.refundId || '',
    row.source || '',
  ].join('|');
}

/**
 * Collapse DEFERRED + RELEASED lifecycle rows that share the same refundId+SKU
 * so Return Proc does not double-count the same Amazon refund.
 */
function collapseRefundLifecycleRows(rows = []) {
  const byRefundId = new Map();
  const withoutId = [];

  for (const row of rows) {
    if (!row) continue;
    const refundId = String(row.refundId || '').trim();
    if (!refundId) {
      withoutId.push(row);
      continue;
    }
    const key = `${refundId}|${row.sku || ''}`;
    const prev = byRefundId.get(key);
    if (!prev) {
      byRefundId.set(key, row);
      continue;
    }

    const prevStatus = String(prev.transactionStatus || '').toUpperCase();
    const nextStatus = String(row.transactionStatus || '').toUpperCase();
    const prevDeferred = prevStatus.includes('DEFERRED');
    const nextReleased = nextStatus.includes('RELEASED') && !nextStatus.includes('DEFERRED');
    const preferNext =
      (nextReleased && prevDeferred)
      || ((Number(row.quantity) || 0) > (Number(prev.quantity) || 0));

    byRefundId.set(key, preferNext ? row : prev);
  }

  return [...byRefundId.values(), ...withoutId];
}

function mergeRefundRows(existing = [], incoming = []) {
  const byKey = new Map();
  for (const row of existing) {
    if (!row) continue;
    byKey.set(refundRowKey(row), row);
  }
  for (const row of incoming) {
    if (!row) continue;
    byKey.set(refundRowKey(row), row);
  }
  return collapseRefundLifecycleRows([...byKey.values()]);
}

/**
 * Persist grouped refunds onto existing orders. Enriches each refund line with
 * asin/productName from the order's own line items (Finances refund events only
 * carry SKU). Merges with any refunds already stored so a shorter lookback sync
 * cannot erase older refund history. Only updates orders that already exist.
 */
async function applyCustomerRefunds(sellerId, grouped) {
  if (grouped.size === 0) {
    return { matchedOrders: 0, updatedOrders: 0 };
  }

  const orderIds = [...grouped.keys()];
  const existing = await Order.find({ sellerId, amazonOrderId: { $in: orderIds } })
    .select('amazonOrderId orderItems refunds latestCustomerReturnDate')
    .lean();

  const existingByOrder = new Map(existing.map((o) => [o.amazonOrderId, o]));

  const bulkOps = [];
  for (const [amazonOrderId, refunds] of grouped.entries()) {
    const order = existingByOrder.get(amazonOrderId);
    if (!order) continue; // order not in DB yet — skip, will catch next cycle

    const orderItems = order.orderItems || [];
    const enrichedIncoming = refunds.map((r) => {
      if (r.sku) {
        const match = orderItems.find((it) => it.sellerSku === r.sku);
        if (match) {
          return { ...r, asin: match.asin || r.asin || null, productName: match.title || r.productName || null };
        }
      }
      // Fall back to the primary item when the refund carries no resolvable SKU.
      const primary = orderItems[0] || {};
      return {
        ...r,
        sku: r.sku || primary.sellerSku || null,
        asin: r.asin || primary.asin || null,
        productName: r.productName || primary.title || null,
      };
    });

    // When listTransactions captured this order, replace prior finances rows so
    // quantity corrections (e.g. 2-unit deferred refund) overwrite stale lines.
    let existingRefunds = order.refunds || [];
    if (enrichedIncoming.some((r) => r.source === 'list_transactions')) {
      existingRefunds = existingRefunds.filter(
        (r) => r?.source
          && r.source !== 'finances_v0'
          && r.source !== 'list_transactions',
      );
    }

    const merged = mergeRefundRows(existingRefunds, enrichedIncoming);
    const latest = latestRefundDate(merged);

    bulkOps.push({
      updateOne: {
        filter: { sellerId, amazonOrderId },
        update: {
          $set: {
            hasRefund: true,
            refunds: merged,
            latestRefundDate: latest,
            latestReturnedActivityDate: maxDate(latest, order.latestCustomerReturnDate),
          },
        },
      },
    });
  }

  if (bulkOps.length === 0) {
    return { matchedOrders: grouped.size, updatedOrders: 0 };
  }

  const result = await Order.bulkWrite(bulkOps, { ordered: false });
  return {
    matchedOrders: grouped.size,
    updatedOrders: result.modifiedCount || 0,
    matchedExisting: result.matchedCount || 0,
  };
}

function buildRefundChunksNewestFirst(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (!(start < end)) {
    return [{ start, end }];
  }

  const chunks = [];
  let cursorEnd = new Date(end);
  while (cursorEnd > start) {
    const chunkStart = new Date(cursorEnd);
    chunkStart.setUTCDate(chunkStart.getUTCDate() - REFUNDS_CHUNK_DAYS);
    if (chunkStart < start) {
      chunks.push({ start: new Date(start), end: new Date(cursorEnd) });
      break;
    }
    chunks.push({ start: new Date(chunkStart), end: new Date(cursorEnd) });
    cursorEnd = new Date(chunkStart);
  }
  return chunks;
}

async function syncCustomerRefunds(user, amazonAPI, startDate) {
  const end = new Date();
  const start = startDate
    ? new Date(startDate)
    : (() => {
        const d = new Date(end);
        d.setUTCDate(d.getUTCDate() - REFUNDS_LOOKBACK_DAYS);
        return d;
      })();

  // Merge refund lines across sources/chunks per order. Prefer listTransactions
  // first so DEFERRED "Refund applied" rows appear before Finances v0 catches up.
  const grouped = new Map();
  let refundEventCount = 0;
  let txRefundCount = 0;

  // Chunk newest-first so a page-cap on an older window cannot starve recent
  // deferred refunds (same pattern as Finances v0).
  const txEnd = new Date(financesPostedBefore(end));
  const txChunks = buildRefundChunksNewestFirst(start, txEnd);

  let txWalkFailed = false;
  try {
    for (const chunk of txChunks) {
      await amazonAPI.iterateTransactions(
        chunk.start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        chunk.end.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        (txs) => {
          for (const tx of txs) {
            const parsed = parseRefundTransaction(tx);
            if (!parsed) continue;
            txRefundCount += 1;
            refundEventCount += 1;
            pushGroupedRefund(grouped, parsed);
          }
        },
        { maxPages: REFUNDS_TX_MAX_PAGES },
      );
    }
  } catch (err) {
    txWalkFailed = true;
    console.warn(
      `[CustomerRefunds] listTransactions walk failed (${err.message}); falling back to Finances v0 only`,
    );
  }

  // Optional secondary: Finances v0 RefundEventList. listTransactions already
  // covers DEFERRED + RELEASED; v0 is slow — only when forced or TX API failed.
  // Do NOT treat "0 refund txs" as failure (quiet accounts are normal).
  let chunks = [];
  const includeV0 = process.env.REFUNDS_INCLUDE_V0 === 'true' || txWalkFailed;
  if (includeV0) {
    chunks = buildRefundChunksNewestFirst(start, txEnd);
    try {
      for (const chunk of chunks) {
        await amazonAPI.iterateFinancialEvents(
          chunk.start.toISOString(),
          chunk.end.toISOString(),
          (events) => {
            const refundEvents = events.RefundEventList || [];
            for (const event of refundEvents) {
              const parsed = parseRefundEvent(event);
              if (!parsed) continue;
              refundEventCount += 1;
              pushGroupedRefund(grouped, parsed);
            }
            return true;
          },
          { maxPages: REFUNDS_MAX_PAGES_PER_CHUNK },
        );
      }
    } catch (err) {
      console.warn(
        `[CustomerRefunds] Finances v0 walk failed (${err.message}); keeping listTransactions results`,
      );
    }
  }

  // Prefer listTransactions rows when both sources returned the same order —
  // otherwise DEFERRED (tx) + later RELEASED (v0) can double returned_units.
  for (const [orderId, rows] of grouped.entries()) {
    const hasTx = rows.some((r) => r?.source === 'list_transactions');
    if (hasTx) {
      grouped.set(
        orderId,
        rows.filter((r) => r?.source === 'list_transactions'),
      );
    }
  }

  const stats = await applyCustomerRefunds(user._id, grouped);
  console.log(
    `[CustomerRefunds] Parsed ${refundEventCount} refund event(s) ` +
      `(listTransactions=${txRefundCount}, txChunks=${txChunks.length}, v0Chunks=${chunks.length}) ` +
      `across ${grouped.size} order(s); updated ${stats.updatedOrders} for seller ${user._id}`,
  );
  return {
    refundEventCount,
    txRefundCount,
    chunks: chunks.length,
    txChunks: txChunks.length,
    ...stats,
  };
}

async function claimRefundsSyncCooldown(userId, { force = false } = {}) {
  if (force) return true;
  const now = new Date();
  const threshold = new Date(now.getTime() - SYNC_COOLDOWN_MS);

  const claimed = await User.findOneAndUpdate(
    {
      _id: userId,
      $or: [
        { customerRefundsSyncScheduledAt: { $exists: false } },
        { customerRefundsSyncScheduledAt: null },
        { customerRefundsSyncScheduledAt: { $lte: threshold } },
      ],
    },
    { $set: { customerRefundsSyncScheduledAt: now } },
  );

  return Boolean(claimed);
}

async function scheduleCustomerRefundsSync(user, amazonAPI, options = {}) {
  if (!user?._id || !amazonAPI) return;

  const userId = String(user._id);
  const allowed = await claimRefundsSyncCooldown(userId, options);
  if (!allowed) return;

  syncCustomerRefunds(user, amazonAPI, options.startDate).catch((error) => {
    console.warn(`[CustomerRefunds] Background sync failed for ${userId}:`, error.message);
  });
}

module.exports = {
  applyCustomerRefunds,
  syncCustomerRefunds,
  scheduleCustomerRefundsSync,
  parseRefundEvent,
  parseRefundTransaction,
  latestRefundDate,
  mergeRefundRows,
  buildRefundChunksNewestFirst,
  REFUNDS_LOOKBACK_DAYS,
  REFUNDS_CHUNK_DAYS,
};
