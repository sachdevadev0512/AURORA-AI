/**
 * Sync Product.listingCreatedDate / lastUpdatedTime for Manage Inventory display.
 *
 * Created → Listings Items summaries.createdDate (matches SC bottom timestamp).
 * Last updated → resolved via listingLastUpdatedResolver (quantity / activation
 * heuristics + optional FBA ledger) — NOT raw summaries.lastUpdatedDate.
 */
const Product = require('../models/Product');
const { coerceValidDate } = require('../utils/productListingUtils');
const { resolveManageInventoryLastUpdated } = require('../utils/listingLastUpdatedResolver');
const { loadLedgerActivityBySku } = require('./ledgerListingActivityService');
const { sleep } = require('../utils/async');

const SEARCH_PAGE_SOFT_CAP = 1000;
const GET_ITEM_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.LISTING_DATES_GET_CONCURRENCY || '3', 10),
);
const GET_ITEM_DELAY_MS = Math.max(
  0,
  parseInt(process.env.LISTING_DATES_GET_DELAY_MS || '200', 10),
);
const USE_LEDGER_FOR_LAST_UPDATED =
  process.env.LISTING_DATES_USE_LEDGER !== 'false';

function pickSummary(item, marketplaceId) {
  const summaries = item?.summaries || [];
  return (
    summaries.find((s) => s.marketplaceId === marketplaceId) ||
    summaries[0] ||
    {}
  );
}

function datesFromListingItem(item, marketplaceId, ledgerBySku = null) {
  const summary = pickSummary(item, marketplaceId);
  const sku = item?.sku;
  const ledger = sku && ledgerBySku ? ledgerBySku.get(sku) || null : null;

  return {
    created: coerceValidDate(summary.createdDate),
    lastUpdated: resolveManageInventoryLastUpdated({
      createdDate: summary.createdDate,
      listingsApiLastUpdated: summary.lastUpdatedDate,
      listingItem: item,
      marketplaceId,
      ledger,
    }),
  };
}

async function applyListingDatesForSku(sellerId, sku, created, lastUpdated) {
  if (!sku || (!created && !lastUpdated)) return false;
  const $set = {};
  if (created) $set.listingCreatedDate = created;
  if (lastUpdated) $set.lastUpdatedTime = lastUpdated;
  const result = await Product.updateOne({ sellerId, sku }, { $set });
  return result.modifiedCount > 0;
}

/**
 * @param {object} options
 * @param {import('../models/User')} options.user
 * @param {import('../utils/amazonAPI')} options.amazonAPI
 * @param {() => boolean} [options.shouldAbort]
 * @param {'search_only'|'search_and_get_missing'} [options.mode]
 */
async function syncListingDatesFromListingsApi({
  user,
  amazonAPI,
  shouldAbort = () => false,
  mode = 'search_and_get_missing',
  useLedger = process.env.LISTING_DATES_USE_LEDGER !== 'false',
} = {}) {
  if (!user?._id || !amazonAPI) {
    return { seen: 0, updated: 0, filledByGet: 0 };
  }

  const marketplaceId = amazonAPI.getMarketplaceId?.() || null;
  let ledgerBySku = null;
  if (useLedger && !shouldAbort()) {
    try {
      console.log('[ListingDates] Loading FBA ledger activity hints…');
      ledgerBySku = await loadLedgerActivityBySku(amazonAPI, shouldAbort);
      console.log(`[ListingDates] Ledger hints for ${ledgerBySku.size} SKU(s)`);
    } catch (err) {
      console.warn('[ListingDates] Ledger load failed:', err.message);
    }
  }

  let pageToken = null;
  let seen = 0;
  let updated = 0;
  const seenSkus = new Set();

  for (let page = 0; page < 80; page += 1) {
    if (shouldAbort()) break;
    const result = await amazonAPI.searchListingsItemsPage(pageToken);
    const items = result.items || [];
    if (!items.length) break;

    for (const item of items) {
      const sku = item.sku;
      if (!sku) continue;
      seen += 1;
      seenSkus.add(sku);
      const { created, lastUpdated } = datesFromListingItem(
        item,
        marketplaceId,
        ledgerBySku,
      );
      if (await applyListingDatesForSku(user._id, sku, created, lastUpdated)) {
        updated += 1;
      }
    }

    pageToken = result.nextToken;
    if (!pageToken) break;
    if (seen >= SEARCH_PAGE_SOFT_CAP) break;
  }

  let filledByGet = 0;
  if (mode === 'search_and_get_missing' && !shouldAbort()) {
    const missing = await Product.find({
      sellerId: user._id,
      sku: { $nin: [...seenSkus] },
    })
      .select('sku')
      .lean();

    const skus = missing.map((p) => p.sku).filter(Boolean);
    for (let i = 0; i < skus.length; i += GET_ITEM_CONCURRENCY) {
      if (shouldAbort()) break;
      const chunk = skus.slice(i, i + GET_ITEM_CONCURRENCY);
      await Promise.all(
        chunk.map(async (sku) => {
          try {
            const item = await amazonAPI.getListingsItem(sku);
            const { created, lastUpdated } = datesFromListingItem(
              item,
              marketplaceId,
              ledgerBySku,
            );
            if (await applyListingDatesForSku(user._id, sku, created, lastUpdated)) {
              filledByGet += 1;
              updated += 1;
            }
          } catch (err) {
            console.warn(
              `[ListingDates] getListingsItem failed for ${sku}:`,
              err.message,
            );
          }
        }),
      );
      if (GET_ITEM_DELAY_MS > 0) await sleep(GET_ITEM_DELAY_MS);
    }
  }

  return { seen, updated, filledByGet, seenSkus: seenSkus.size };
}

module.exports = {
  syncListingDatesFromListingsApi,
  datesFromListingItem,
};
