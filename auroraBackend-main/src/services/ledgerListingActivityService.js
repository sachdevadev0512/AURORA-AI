/**
 * Build per-SKU FBA ledger activity hints for Manage Inventory last-updated.
 * Uses GET_LEDGER_DETAIL_VIEW_DATA in monthly chunks (Amazon cancels very old windows).
 */
const { coerceValidDate } = require('../utils/productListingUtils');
const { sleep } = require('../utils/async');

const CHUNK_DAYS = 31;
const MAX_LOOKBACK_DAYS = Math.max(
  90,
  parseInt(process.env.LISTING_LEDGER_LOOKBACK_DAYS || '540', 10),
);
const CHUNK_DELAY_MS = Math.max(
  0,
  parseInt(process.env.LISTING_LEDGER_CHUNK_DELAY_MS || '300', 10),
);

/** Event types that reflect merchant-visible quantity / inventory changes in SC. */
const SC_ACTIVITY_EVENT_TYPES = new Set([
  'Receipts',
  'Adjustments',
  'CustomerReturns',
  'VendorReturns',
  'Shipments',
  'WhseTransfers',
]);

function reportCell(row, key) {
  if (row == null) return undefined;
  if (row[key] !== undefined) return row[key];
  const normalized = key.toLowerCase();
  const match = Object.keys(row).find((k) => {
    const clean = String(k).replace(/^"|"$/g, '').trim().toLowerCase();
    return clean === normalized;
  });
  return match ? row[match] : undefined;
}

function parseLedgerTimestamp(raw) {
  if (raw == null || raw === '') return null;
  const text = String(raw).replace(/^"|"$/g, '').trim();
  if (!text) return null;
  const parsed = coerceValidDate(text);
  return parsed;
}

function parseLedgerRow(row) {
  const sku = String(reportCell(row, 'MSKU') || reportCell(row, 'sku') || '').trim();
  if (!sku) return null;

  const eventType = String(reportCell(row, 'Event Type') || reportCell(row, 'event-type') || '')
    .replace(/^"|"$/g, '')
    .trim();
  const qtyRaw = reportCell(row, 'Quantity') ?? reportCell(row, 'quantity');
  const qty = Number(String(qtyRaw || '').replace(/^"|"$/g, ''));
  const when =
    parseLedgerTimestamp(reportCell(row, 'Date and Time')) ||
    parseLedgerTimestamp(reportCell(row, 'Date'));

  if (!when || !eventType) return null;
  return { sku, eventType, qty, when };
}

function applyLedgerEvent(map, { sku, eventType, qty, when }) {
  if (!map.has(sku)) {
    map.set(sku, { firstReceipt: null, lastActivity: null, activityTimes: [] });
  }
  const entry = map.get(sku);

  if (eventType === 'Receipts' && Number.isFinite(qty) && qty > 0) {
    if (!entry.firstReceipt || when.getTime() < entry.firstReceipt.getTime()) {
      entry.firstReceipt = when;
    }
  }

  if (SC_ACTIVITY_EVENT_TYPES.has(eventType)) {
    entry.activityTimes.push(when);
    if (!entry.lastActivity || when.getTime() > entry.lastActivity.getTime()) {
      entry.lastActivity = when;
    }
  }
}

/**
 * @param {import('../utils/amazonAPI')} amazonAPI
 * @param {() => boolean} [shouldAbort]
 * @returns {Promise<Map<string, { firstReceipt: Date|null, lastActivity: Date|null }>>}
 */
async function loadLedgerActivityBySku(amazonAPI, shouldAbort = () => false) {
  const map = new Map();
  if (!amazonAPI?.createReport || !amazonAPI?.waitForReportDocument) {
    return map;
  }

  const marketplaceId = amazonAPI.getMarketplaceId?.();
  if (!marketplaceId) return map;

  const end = new Date();
  const start = new Date(end.getTime() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const totalChunks = Math.ceil((end.getTime() - start.getTime()) / (CHUNK_DAYS * 86400000));
  let chunkIdx = 0;

  for (let cursor = new Date(start); cursor < end; ) {
    if (shouldAbort()) break;
    chunkIdx += 1;

    const chunkEnd = new Date(Math.min(end.getTime(), cursor.getTime() + CHUNK_DAYS * 86400000));
    const label = `${cursor.toISOString().slice(0, 10)} → ${chunkEnd.toISOString().slice(0, 10)}`;
    console.log(`[LedgerActivity] chunk ${chunkIdx}/${totalChunks}: ${label}`);
    try {
      const created = await amazonAPI.createReport(
        'GET_LEDGER_DETAIL_VIEW_DATA',
        new Date(cursor),
        new Date(chunkEnd),
        [marketplaceId],
      );
      const doc = await amazonAPI.waitForReportDocument(created.reportId, {
        maxAttempts: 90,
      });
      const rows = await amazonAPI.sellingPartner.download(doc, { json: true });
      const list = Array.isArray(rows) ? rows : [];
      let events = 0;
      for (const row of list) {
        const parsed = parseLedgerRow(row);
        if (parsed) {
          applyLedgerEvent(map, parsed);
          events += 1;
        }
      }
      console.log(
        `[LedgerActivity] chunk ${chunkIdx}/${totalChunks} done: ${list.length} rows, ${events} events, ${map.size} SKU(s)`,
      );
    } catch (err) {
      console.warn(`[LedgerActivity] chunk ${chunkIdx}/${totalChunks} failed (${label}):`, err.message);
    }

    cursor = new Date(chunkEnd.getTime() + 86400000);
    if (CHUNK_DELAY_MS > 0) await sleep(CHUNK_DELAY_MS);
  }

  return map;
}

module.exports = {
  loadLedgerActivityBySku,
  parseLedgerRow,
  SC_ACTIVITY_EVENT_TYPES,
};
