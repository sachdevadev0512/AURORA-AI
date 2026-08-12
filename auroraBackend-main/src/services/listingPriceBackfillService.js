const Product = require('../models/Product');
const { extractListingBoundPrices } = require('../utils/listingPriceParser');

const DEFAULT_CONCURRENCY = Math.max(
  1,
  Number(process.env.BACKFILL_PRICE_CONCURRENCY || 4),
);

function money(amount, currency = 'USD') {
  const parsed = Number(amount);
  return {
    amount: Number.isFinite(parsed) ? parsed : 0,
    currency: currency || 'USD',
  };
}

function mergeMoneyField(existing, parsed) {
  const parsedAmount = Number(parsed?.amount ?? 0);
  if (parsedAmount > 0) return parsed;
  const existingAmount = Number(existing?.amount ?? 0);
  if (existingAmount > 0) return existing;
  return parsed || money(0);
}

function boundPricesFromListing(listing) {
  return {
    price: listing?.price,
    shippingCost: listing?.shippingCost,
    minimumPrice: listing?.minimumPrice,
    maximumPrice: listing?.maximumPrice,
    businessPrice: listing?.businessPrice,
  };
}

function listingPriceFieldChanged(existing, merged) {
  const existingAmount = Number(existing?.amount ?? 0);
  const mergedAmount = Number(merged?.amount ?? 0);
  if (mergedAmount <= 0 && existingAmount > 0) return false;
  return Math.abs(existingAmount - mergedAmount) > 0.001;
}

function buildListingPriceUpdate(existing, listing) {
  if (!listing) return null;
  const update = {};
  for (const [field, parsed] of Object.entries(boundPricesFromListing(listing))) {
    const merged = mergeMoneyField(existing?.[field], parsed);
    if (listingPriceFieldChanged(existing?.[field], merged)) {
      update[field] = merged;
    }
  }
  return Object.keys(update).length > 0 ? update : null;
}

function listingPriceFieldsDiffer(existing, listing) {
  return buildListingPriceUpdate(existing, listing) != null;
}

function boundPricesMissing(values) {
  return (
    Number(values?.minimumPrice?.amount ?? 0) <= 0 &&
    Number(values?.maximumPrice?.amount ?? 0) <= 0 &&
    Number(values?.businessPrice?.amount ?? 0) <= 0
  );
}

const { sleep, mapWithConcurrency } = require('../utils/async');

async function enrichListingItemForBoundPrices(amazonAPI, listingItem, existing, marketplaceId) {
  const attributes = listingItem?.attributes || {};
  const quick = extractListingBoundPrices(attributes, marketplaceId, listingItem?.offers);
  const searchMissing = boundPricesMissing({
    minimumPrice: money(quick.minimumPrice, quick.currency),
    maximumPrice: money(quick.maximumPrice, quick.currency),
    businessPrice: money(quick.businessPrice, quick.currency),
  });

  if (!searchMissing) return listingItem;
  if (!boundPricesMissing(existing)) return listingItem;

  try {
    const full = await amazonAPI.getListingsItem(listingItem.sku);
    if (!full?.attributes) return listingItem;

    return {
      ...listingItem,
      attributes: full.attributes,
      offers: full.offers ?? listingItem.offers,
    };
  } catch (error) {
    console.warn(
      `[ListingPriceBackfill] getListingsItem failed for ${listingItem.sku}: ${error.message}`,
    );
    return listingItem;
  }
}

async function backfillListingBoundPrices({
  sellerId,
  amazonAPI,
  marketplaceId,
  asin = null,
  limit = null,
  concurrency = DEFAULT_CONCURRENCY,
  onProgress = null,
  shouldAbort = () => false,
}) {
  const filter = asin
    ? { sellerId, asin }
    : {
        sellerId,
        // Re-poll until min or max is known. Business price is optional (many listings
        // have no B2B offer); still captured opportunistically on each fetch.
        $or: [
          { minimumPrice: { $exists: false } },
          { maximumPrice: { $exists: false } },
          { 'minimumPrice.amount': { $lte: 0 } },
          { 'maximumPrice.amount': { $lte: 0 } },
        ],
      };

  let query = Product.find(filter).select('_id sku asin minimumPrice maximumPrice businessPrice');
  if (limit) query = query.limit(limit);
  const products = await query.lean();

  let updated = 0;
  let noData = 0;
  let failed = 0;

  await mapWithConcurrency(products, concurrency, async (product, idx) => {
    if (shouldAbort()) return;
    try {
      const listing = await amazonAPI.getListingsItem(product.sku);
      if (!listing?.attributes) {
        noData += 1;
        return;
      }

      const bound = extractListingBoundPrices(
        listing.attributes,
        marketplaceId,
        listing.offers,
      );
      const parsedListing = {
        minimumPrice: money(bound.minimumPrice, bound.currency),
        maximumPrice: money(bound.maximumPrice, bound.currency),
        businessPrice: money(bound.businessPrice, bound.currency),
      };
      const update = buildListingPriceUpdate(product, parsedListing);
      if (!update) {
        noData += 1;
        return;
      }

      await Product.updateOne({ _id: product._id }, { $set: update });
      updated += 1;
      if (onProgress) onProgress({ idx, total: products.length, asin: product.asin, update });
    } catch (error) {
      failed += 1;
      if (onProgress) onProgress({ idx, total: products.length, asin: product.asin, error });
    }
  });

  return { scanned: products.length, updated, noData, failed };
}

module.exports = {
  money,
  mergeMoneyField,
  buildListingPriceUpdate,
  listingPriceFieldsDiffer,
  boundPricesMissing,
  enrichListingItemForBoundPrices,
  backfillListingBoundPrices,
};
