const Product = require('../models/Product');
const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');

const VERIFY_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.INVENTORY_SYNC_CATALOG_CONCURRENCY || '5', 10)
);

function buildMarkRemovedFromSellerCentralUpdate() {
  return {
    isListedOnAmazon: false,
    listingStatus: 'Removed from Seller Central',
    status: 'Inactive',
    lastSynced: new Date(),
  };
}

function buildRestoreListedUpdate() {
  return {
    isListedOnAmazon: true,
    // Keep them visible in the default "On Seller Central" product view until
    // the next full inventory sync refreshes listingStatus/status from Amazon.
    status: 'Active',
    listingStatus: 'BUYABLE',
    lastSynced: new Date(),
  };
}

const { mapWithConcurrency } = require('../utils/async');

async function loadLiveSellerSkus(amazonAPI, shouldAbort = () => false) {
  const syncedSkus = new Set();
  let nextToken = null;

  do {
    if (shouldAbort()) break;
    const { items, nextToken: newToken } = await amazonAPI.searchListingsItemsPage(nextToken);
    for (const item of items || []) {
      if (item.sku) syncedSkus.add(item.sku);
    }
    nextToken = newToken;
  } while (nextToken);

  return syncedSkus;
}

function isConfirmedNotFoundError(error) {
  const code = error?.code || error?.response?.data?.errors?.[0]?.code;
  return code === 'NOT_FOUND';
}

/** Verify deleted SKUs via getListingsItem; optionally uses listings search results. */
async function reconcileDeletedListingsWithAmazon(
  user,
  amazonAPI,
  syncedSkus,
  bulkOps,
  shouldAbort = () => false,
  options = {},
) {
  const sellerId = user._id;
  const verifyBySku = new Map();
  const skipWhenIncomplete = options.skipWhenIncomplete === true;
  const liveSkuCount = syncedSkus ? syncedSkus.size : 0;

  // Never mass-delete when we could not load any live SKUs (API failure / empty page).
  if (!syncedSkus || liveSkuCount === 0) {
    console.warn(
      `[ListingReconcile] Skipping delete reconcile for ${String(sellerId)} — live SKU set is empty`,
    );
    return { verified: 0, removed: 0, skipped: true, reason: 'empty_live_sku_set' };
  }

  if (skipWhenIncomplete) {
    console.warn(
      `[ListingReconcile] Skipping delete reconcile for ${String(sellerId)} — listings sync was partial`,
    );
    return { verified: 0, removed: 0, skipped: true, reason: 'partial_listings_sync' };
  }

  if (syncedSkus && syncedSkus.size > 0) {
    const notSynced = await Product.find({
      sellerId,
      sku: { $nin: [...syncedSkus] },
      $or: [{ isListedOnAmazon: { $ne: false } }, { isListedOnAmazon: null }],
    })
      .select('_id sku')
      .lean();

    for (const row of notSynced) {
      verifyBySku.set(row.sku, row._id);
    }
  }

  const duplicateGroups = await Product.aggregate([
    {
      $match: {
        sellerId,
        $or: [{ isListedOnAmazon: { $ne: false } }, { isListedOnAmazon: null }],
      },
    },
    {
      $group: {
        _id: '$asin',
        products: { $push: { _id: '$_id', sku: '$sku' } },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  for (const group of duplicateGroups) {
    for (const product of group.products) {
      // Only re-check duplicate ASINs that were NOT in this sync snapshot.
      if (syncedSkus.has(product.sku)) continue;
      verifyBySku.set(product.sku, product._id);
    }
  }

  const staleCandidates = await Product.find({
    sellerId,
    $or: [{ isListedOnAmazon: { $ne: false } }, { isListedOnAmazon: null }],
    status: 'Inactive',
    listingStatus: null,
    listingCreatedDate: null,
  })
    .select('_id sku')
    .lean();

  for (const row of staleCandidates) {
    if (syncedSkus.has(row.sku)) continue;
    verifyBySku.set(row.sku, row._id);
  }

  if (verifyBySku.size === 0) {
    return { verified: 0, removed: 0 };
  }

  let removedCount = 0;
  let apiErrors = 0;
  await mapWithConcurrency(
    [...verifyBySku.entries()],
    VERIFY_CONCURRENCY,
    async ([sku, productId]) => {
      if (shouldAbort()) return;
      try {
        const item = await amazonAPI.getListingsItem(sku);
        if (!item?.summaries?.length) {
          // Confirmed missing (getListingsItem returns null only on NOT_FOUND).
          bulkOps.push({
            updateOne: {
              filter: { _id: productId },
              update: { $set: buildMarkRemovedFromSellerCentralUpdate() },
            },
          });
          removedCount += 1;
        } else {
          bulkOps.push({
            updateOne: {
              filter: { _id: productId },
              update: {
                $set: {
                  isListedOnAmazon: true,
                  lastSynced: new Date(),
                },
              },
            },
          });
        }
      } catch (error) {
        if (isConfirmedNotFoundError(error)) {
          bulkOps.push({
            updateOne: {
              filter: { _id: productId },
              update: { $set: buildMarkRemovedFromSellerCentralUpdate() },
            },
          });
          removedCount += 1;
          return;
        }
        apiErrors += 1;
        console.warn(
          `[ListingReconcile] Leaving ${sku} unchanged after getListingsItem error: ${error.message}`,
        );
      }
    },
    shouldAbort
  );

  return { verified: verifyBySku.size, removed: removedCount, apiErrors };
}

/**
 * Restore products incorrectly marked Removed when their SKU is still returned by
 * Amazon searchListingsItems. Returns counts for logging/API responses.
 */
async function restoreLiveListingsMarkedRemoved(user, { shouldAbort = () => false } = {}) {
  const sellerAppCredentials = await getSellerAppCredentials(user._id);
  const amazonAPI = new AmazonAPI(user, sellerAppCredentials);
  const liveSkus = await loadLiveSellerSkus(amazonAPI, shouldAbort);

  if (liveSkus.size === 0) {
    return { liveSkusOnAmazon: 0, restored: 0, skipped: true, reason: 'empty_live_sku_set' };
  }

  const result = await Product.updateMany(
    {
      sellerId: user._id,
      isListedOnAmazon: false,
      listingStatus: 'Removed from Seller Central',
      sku: { $in: [...liveSkus] },
    },
    { $set: buildRestoreListedUpdate() },
  );

  return {
    liveSkusOnAmazon: liveSkus.size,
    restored: result.modifiedCount || 0,
    matched: result.matchedCount || 0,
  };
}

async function reconcileSellerListings(user, { shouldAbort = () => false } = {}) {
  const sellerAppCredentials = await getSellerAppCredentials(user._id);
  const amazonAPI = new AmazonAPI(user, sellerAppCredentials);
  const syncedSkus = await loadLiveSellerSkus(amazonAPI, shouldAbort);
  const bulkOps = [];

  const result = await reconcileDeletedListingsWithAmazon(
    user,
    amazonAPI,
    syncedSkus,
    bulkOps,
    shouldAbort,
  );

  if (bulkOps.length > 0) {
    await Product.bulkWrite(bulkOps, { ordered: false, runValidators: true });
  }

  return {
    liveSkusOnAmazon: syncedSkus.size,
    verified: result.verified,
    removed: result.removed,
    skipped: Boolean(result.skipped),
    reason: result.reason,
    apiErrors: result.apiErrors || 0,
  };
}

module.exports = {
  buildMarkRemovedFromSellerCentralUpdate,
  buildRestoreListedUpdate,
  loadLiveSellerSkus,
  reconcileDeletedListingsWithAmazon,
  restoreLiveListingsMarkedRemoved,
  reconcileSellerListings,
};
