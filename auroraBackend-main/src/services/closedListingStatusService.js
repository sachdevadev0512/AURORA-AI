const Product = require('../models/Product');
const { deriveProductStatus } = require('../utils/productListingUtils');
const { mapWithConcurrency } = require('../utils/async');

const DEFAULT_CONCURRENCY = Math.max(
  1,
  Number(process.env.BACKFILL_CLOSED_STATUS_CONCURRENCY || 4),
);

/**
 * Merchant listings reports label Closed and Inactive alike as "Inactive".
 * Re-read Listings Items purchasable_offer.end_at to set status = Closed when
 * the offer window has ended (matches Seller Central "Closed" + Reactivate).
 */
async function backfillClosedListingStatuses({
  sellerId,
  amazonAPI,
  marketplaceId,
  concurrency = DEFAULT_CONCURRENCY,
  onProgress = null,
  shouldAbort = () => false,
} = {}) {
  const products = await Product.find({
    sellerId,
    status: { $in: ['Inactive', 'Closed'] },
    isListedOnAmazon: { $ne: false },
  })
    .select('_id sku asin status listingStatus')
    .lean();

  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  await mapWithConcurrency(products, concurrency, async (product, idx) => {
    if (shouldAbort()) return;
    try {
      const listing = await amazonAPI.getListingsItem(product.sku);
      if (!listing) {
        unchanged += 1;
        return;
      }

      const summary = listing.summaries?.[0];
      const listingStatuses = summary?.status || [];
      const listingStatus = Array.isArray(listingStatuses)
        ? listingStatuses.join(', ')
        : summary?.status || product.listingStatus || null;

      const nextStatus = deriveProductStatus({
        listingStatus,
        attributes: listing.attributes || {},
        marketplaceId,
      });

      if (nextStatus === product.status && (!listingStatus || listingStatus === product.listingStatus)) {
        unchanged += 1;
        return;
      }

      const update = {
        status: nextStatus,
        updatedAt: new Date(),
        lastSynced: new Date(),
      };
      if (listingStatus) update.listingStatus = listingStatus;

      await Product.updateOne({ _id: product._id }, { $set: update });
      updated += 1;
      if (onProgress) {
        onProgress({ idx, total: products.length, sku: product.sku, status: nextStatus });
      }
    } catch (error) {
      failed += 1;
      if (onProgress) onProgress({ idx, total: products.length, sku: product.sku, error });
    }
  });

  return { scanned: products.length, updated, unchanged, failed };
}

module.exports = {
  backfillClosedListingStatuses,
};
