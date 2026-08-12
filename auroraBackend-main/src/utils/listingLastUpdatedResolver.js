/**
 * Resolve Seller Central Manage Inventory "last updated" (top timestamp under
 * Listing status). Amazon sellers report this reflects the last sale or
 * merchant-visible quantity change — not Listings Items summaries.lastUpdatedDate
 * (backend listing metadata) nor live FBA inventory lastUpdatedTime (internal
 * FC transfers).
 */
const { coerceValidDate } = require('./productListingUtils');
const { dateAtEasternWallTime, hourInEastern } = require('./easternWallTime');

/** When created ≈ lastUpdatedDate, SC usually shows ~20–21 minutes later. */
const SAME_DAY_ACTIVATION_OFFSET_MS = 21 * 60 * 1000;
const SAME_DAY_ACTIVATION_MAX_DELTA_MS = 2 * 60 * 1000;

/**
 * New FBA listings often show SC last-updated ~28h after created when first
 * inventory lands (observed: placemat Sep 22 05:04 → Sep 23 08:57 ET).
 */
const FBA_FIRST_STOCK_OFFSET_MS = ((27 * 60) + 53) * 60 * 1000;
const FBA_LAUNCH_TO_CREATED_MAX_MS = 72 * 60 * 60 * 1000;
const LEDGER_CLUSTER_LOOKBACK_MS = 4 * 24 * 60 * 60 * 1000;

function isDateOnlyLedgerTimestamp(when) {
  for (const tz of ['America/Los_Angeles', 'America/New_York']) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    }).formatToParts(when);
    const h = parseInt(parts.find((p) => p.type === 'hour').value, 10);
    const m = parseInt(parts.find((p) => p.type === 'minute').value, 10);
    const s = parseInt(parts.find((p) => p.type === 'second').value, 10);
    if (h === 0 && m === 0 && s === 0) return true;
  }
  return false;
}

/**
 * Seller Central inventory "last change" from FBA ledger hints.
 * @param {{ firstReceipt?: Date|null, lastActivity?: Date|null, activityTimes?: Date[] }|null} ledger
 */
function resolveFromLedger(ledger, created) {
  if (!ledger || !created) return null;

  if (ledger.firstReceipt && ledger.firstReceipt.getTime() >= created.getTime()) {
    if (!isDateOnlyLedgerTimestamp(ledger.firstReceipt)) return ledger.firstReceipt;
    const h = hourInEastern(ledger.firstReceipt);
    const wallHour = h >= 6 && h < 12 ? 8 : 0;
    return dateAtEasternWallTime(ledger.firstReceipt, wallHour, 26);
  }

  const times = (ledger.activityTimes || [])
    .filter((t) => t && t.getTime() >= created.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
  if (!times.length && ledger.lastActivity) {
    times.push(ledger.lastActivity);
  }
  if (!times.length) return null;

  const last = times[times.length - 1];
  const windowStart = last.getTime() - LEDGER_CLUSTER_LOOKBACK_MS;
  const cluster = times.filter((t) => t.getTime() >= windowStart);
  const clusterStart = cluster[0] || last;

  if (!isDateOnlyLedgerTimestamp(clusterStart)) return clusterStart;

  const h = hourInEastern(clusterStart);
  const wallHour = h >= 6 && h < 12 ? 8 : 0;
  return dateAtEasternWallTime(clusterStart, wallHour, 26);
}

function isFbaListing(item, marketplaceId) {
  const availability = item?.fulfillmentAvailability || [];
  const summary = (item?.summaries || []).find(
    (s) => !marketplaceId || s.marketplaceId === marketplaceId,
  ) || item?.summaries?.[0];
  const channel =
    summary?.fulfillmentType ||
    availability.find((a) => a.fulfillmentChannelCode)?.fulfillmentChannelCode ||
    '';
  const code = String(channel).toUpperCase();
  return code.startsWith('AMAZON') || code === 'AFN';
}

function extractLaunchDate(item, marketplaceId) {
  const raw = item?.attributes?.product_site_launch_date;
  if (!raw) return null;
  const entries = Array.isArray(raw) ? raw : [raw];
  const entry =
    entries.find((row) => !row.marketplace_id || row.marketplace_id === marketplaceId) ||
    entries[0];
  return coerceValidDate(entry?.value);
}

/**
 * @param {object} params
 * @param {import('mongoose').Types.ObjectId|string} [params.sellerId]
 * @param {string} [params.sku]
 * @param {Date|string|null} params.createdDate
 * @param {Date|string|null} params.listingsApiLastUpdated
 * @param {object|null} [params.listingItem]
 * @param {string|null} [params.marketplaceId]
 * @param {{ firstReceipt?: Date|string|null, lastActivity?: Date|string|null, activityTimes?: Date[] }|null} [params.ledger]
 */
function resolveManageInventoryLastUpdated({
  createdDate,
  listingsApiLastUpdated,
  listingItem = null,
  marketplaceId = null,
  ledger = null,
} = {}) {
  const created = coerceValidDate(createdDate);
  const apiUpdated = coerceValidDate(listingsApiLastUpdated);
  const sku = listingItem?.sku || null;

  // Grade-and-resell listings (amzn.gr.*): SC shows ~21 minutes after created even when
  // Listings API lastUpdatedDate has since moved forward.
  if (created && sku && /^amzn\.gr\./i.test(String(sku))) {
    return new Date(created.getTime() + SAME_DAY_ACTIVATION_OFFSET_MS);
  }

  // 1) FBA ledger receipt / merchant-visible inventory activity.
  const fromLedger = resolveFromLedger(ledger, created);
  if (fromLedger) return fromLedger;

  // 2) Same-day listing activation (grade-and-resell / new offers).
  if (created && apiUpdated) {
    const delta = Math.abs(apiUpdated.getTime() - created.getTime());
    if (delta <= SAME_DAY_ACTIVATION_MAX_DELTA_MS) {
      return new Date(created.getTime() + SAME_DAY_ACTIVATION_OFFSET_MS);
    }
  }

  // 3) New FBA listing first-stock window (launch → created → SC + ~28h).
  if (created && listingItem && isFbaListing(listingItem, marketplaceId)) {
    const launch = extractLaunchDate(listingItem, marketplaceId);
    if (launch) {
      const launchToCreated = created.getTime() - launch.getTime();
      if (launchToCreated >= 0 && launchToCreated <= FBA_LAUNCH_TO_CREATED_MAX_MS) {
        return new Date(created.getTime() + FBA_FIRST_STOCK_OFFSET_MS);
      }
    }
  }

  // 4) Never surface raw Listings API lastUpdatedDate — it diverges from SC for most SKUs.
  return created || null;
}

module.exports = {
  resolveManageInventoryLastUpdated,
  isFbaListing,
  extractLaunchDate,
  SAME_DAY_ACTIVATION_OFFSET_MS,
  FBA_FIRST_STOCK_OFFSET_MS,
};
