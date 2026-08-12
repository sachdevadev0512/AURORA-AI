const Order = require('../models/Order');
const User = require('../models/User');
const { groupReturnsByOrderId } = require('../utils/fbaReturnsParser');

const SYNC_COOLDOWN_MS = 60 * 60 * 1000;
/** Amazon FBA returns reports are most reliable in ~30 day windows. */
const RETURNS_CHUNK_DAYS = 30;
/** How far back we keep returns in sync for every seller. */
const RETURNS_LOOKBACK_DAYS = 365;

function latestReturnDate(customerReturns = []) {
  let latest = null;
  for (const row of customerReturns) {
    const ts = row?.returnDate ? new Date(row.returnDate).getTime() : NaN;
    if (!Number.isFinite(ts)) continue;
    if (latest == null || ts > latest.getTime()) {
      latest = new Date(ts);
    }
  }
  return latest;
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

/** Stable key so chunked syncs merge instead of wiping earlier return rows. */
function returnRowKey(row = {}) {
  const dateIso = row.returnDate ? new Date(row.returnDate).toISOString() : '';
  return [
    dateIso,
    row.sku || '',
    row.asin || '',
    row.quantity ?? '',
    row.disposition || '',
    row.status || '',
    row.fulfillmentCenterId || '',
  ].join('|');
}

function mergeReturnRows(existing = [], incoming = []) {
  const byKey = new Map();
  for (const row of existing) {
    if (!row) continue;
    byKey.set(returnRowKey(row), row);
  }
  for (const row of incoming) {
    if (!row) continue;
    byKey.set(returnRowKey(row), row);
  }
  return [...byKey.values()];
}

function buildReturnChunks(startDate, endDate) {
  const end = new Date(endDate);
  let cursor = new Date(startDate);
  if (!(cursor < end)) {
    return [{ start: new Date(startDate), end }];
  }

  const chunks = [];
  while (cursor < end) {
    const chunkStart = new Date(cursor);
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + RETURNS_CHUNK_DAYS);
    if (chunkEnd > end) {
      chunks.push({ start: chunkStart, end });
      break;
    }
    chunks.push({ start: chunkStart, end: chunkEnd });
    cursor = new Date(chunkEnd);
    cursor.setUTCMilliseconds(cursor.getUTCMilliseconds() + 1);
  }
  return chunks;
}

async function applyCustomerReturns(sellerId, rows) {
  const grouped = groupReturnsByOrderId(rows);
  if (grouped.size === 0) {
    return { matchedOrders: 0, updatedOrders: 0, failedOrders: 0 };
  }

  const orderIds = [...grouped.keys()];
  const existingOrders = await Order.find({ sellerId, amazonOrderId: { $in: orderIds } })
    .select('amazonOrderId customerReturns latestRefundDate')
    .lean();
  const existingByOrder = new Map(
    existingOrders.map((o) => [o.amazonOrderId, o]),
  );

  const bulkOps = [];

  for (const [amazonOrderId, incomingReturns] of grouped.entries()) {
    const existing = existingByOrder.get(amazonOrderId);
    // No upsert — returns only attach to orders already in the DB.
    if (!existing) continue;

    const customerReturns = mergeReturnRows(existing.customerReturns || [], incomingReturns);
    const latestCustomerReturnDate = latestReturnDate(customerReturns);

    bulkOps.push({
      updateOne: {
        filter: { sellerId, amazonOrderId },
        update: {
          $set: {
            hasCustomerReturn: true,
            customerReturns,
            latestCustomerReturnDate,
            latestReturnedActivityDate: maxDate(
              latestCustomerReturnDate,
              existing.latestRefundDate,
            ),
          },
        },
      },
    });
  }

  if (bulkOps.length === 0) {
    return { matchedOrders: grouped.size, updatedOrders: 0, failedOrders: 0 };
  }

  try {
    const result = await Order.bulkWrite(bulkOps, { ordered: false });
    return {
      matchedOrders: grouped.size,
      updatedOrders: result.modifiedCount || 0,
      matchedExisting: result.matchedCount || 0,
      failedOrders: 0,
    };
  } catch (error) {
    const writeErrors = error?.writeErrors || error?.result?.writeErrors;
    if (!Array.isArray(writeErrors) || writeErrors.length === 0) {
      throw error;
    }

    const failedIndexes = new Set(
      writeErrors
        .map((entry) => entry?.index)
        .filter((index) => Number.isInteger(index) && index >= 0),
    );

    console.warn(
      `[CustomerReturns] Partial bulk failure: ${writeErrors.length} row(s) failed; continuing with successful updates.`,
    );

    return {
      matchedOrders: grouped.size,
      updatedOrders: Math.max(0, bulkOps.length - failedIndexes.size),
      failedOrders: failedIndexes.size,
    };
  }
}

async function syncCustomerReturns(user, amazonAPI, startDate, endDate) {
  const chunks = buildReturnChunks(startDate, endDate);
  let matchedOrders = 0;
  let updatedOrders = 0;
  let failedOrders = 0;
  let rowCount = 0;

  for (const chunk of chunks) {
    const rows = await amazonAPI.fetchFbaCustomerReturnsReport(
      chunk.start.toISOString(),
      chunk.end.toISOString(),
    );
    rowCount += Array.isArray(rows) ? rows.length : 0;
    const stats = await applyCustomerReturns(user._id, rows);
    matchedOrders += stats.matchedOrders || 0;
    updatedOrders += stats.updatedOrders || 0;
    failedOrders += stats.failedOrders || 0;
  }

  console.log(
    `[CustomerReturns] Synced ${rowCount} return row(s) across ${chunks.length} chunk(s); ` +
      `matched ${matchedOrders} order(s), updated ${updatedOrders}, failed ${failedOrders} for seller ${user._id}`,
  );
  return { matchedOrders, updatedOrders, failedOrders, rowCount, chunks: chunks.length };
}

async function claimReturnsSyncCooldown(userId, { force = false } = {}) {
  if (force) return true;
  const now = new Date();
  const threshold = new Date(now.getTime() - SYNC_COOLDOWN_MS);

  const claimed = await User.findOneAndUpdate(
    {
      _id: userId,
      $or: [
        { customerReturnsSyncScheduledAt: { $exists: false } },
        { customerReturnsSyncScheduledAt: null },
        { customerReturnsSyncScheduledAt: { $lte: threshold } },
      ],
    },
    {
      $set: {
        customerReturnsSyncScheduledAt: now,
      },
    },
  );

  return Boolean(claimed);
}

function resolveReturnsWindow(options = {}) {
  const endDate = options.endDate ? new Date(options.endDate) : new Date();
  const startDate = options.startDate
    ? new Date(options.startDate)
    : (() => {
        const start = new Date(endDate);
        start.setUTCDate(start.getUTCDate() - RETURNS_LOOKBACK_DAYS);
        return start;
      })();
  return { startDate, endDate };
}

async function scheduleCustomerReturnsSync(user, amazonAPI, options = {}) {
  if (!user?._id || !amazonAPI) return;

  const userId = String(user._id);
  const allowed = await claimReturnsSyncCooldown(userId, options);
  if (!allowed) {
    return;
  }

  const { startDate, endDate } = resolveReturnsWindow(options);

  syncCustomerReturns(user, amazonAPI, startDate, endDate).catch((error) => {
    console.warn(`[CustomerReturns] Background sync failed for ${userId}:`, error.message);
  });
}

module.exports = {
  applyCustomerReturns,
  syncCustomerReturns,
  scheduleCustomerReturnsSync,
  latestReturnDate,
  buildReturnChunks,
  mergeReturnRows,
  RETURNS_LOOKBACK_DAYS,
  RETURNS_CHUNK_DAYS,
};
