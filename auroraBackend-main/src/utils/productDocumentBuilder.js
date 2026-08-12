const {
  mapAmazonListingStatus,
  getSellableQuantity,
  applyInventoryToListingStatus,
  parseAmazonOpenDate,
  coerceValidDate,
} = require('./productListingUtils');
const { mergeMoneyField } = require('../services/listingPriceBackfillService');
const {
  money,
  normalizeFulfillmentType,
  mapConditionType,
  getListingSummary,
  getMerchantQuantity,
} = require('./listingItemParse');
const { inventoryFieldsFromFbaItem } = require('./fbaInventoryFields');

function normalizeImageEntry(image) {
  if (!image) return null;
  const url = image.url || image.link || image.Link || null;
  if (!url) return null;
  return {
    url: String(url),
    height: image.height ?? image.Height ?? undefined,
    width: image.width ?? image.Width ?? undefined,
  };
}

/**
 * Prefer catalog MAIN image, then any catalog image, then listing/report/existing
 * fallbacks. Never return [] when a prior image exists — inventory rebuilds must
 * not wipe thumbnails when catalog calls fail or are skipped.
 */
function extractPrimaryImage(catalogItem, fallbacks = {}) {
  const imageSets = catalogItem?.images || catalogItem?.Images || [];
  let mainCandidate = null;
  let anyCandidate = null;

  for (const imageSet of imageSets) {
    const images = imageSet?.images || imageSet?.Images || [];
    if (!Array.isArray(images) || images.length === 0) continue;
    for (const img of images) {
      const entry = normalizeImageEntry(img);
      if (!entry) continue;
      if (!anyCandidate) anyCandidate = entry;
      if (String(img.variant || img.Variant || '').toUpperCase() === 'MAIN') {
        mainCandidate = entry;
        break;
      }
    }
    if (mainCandidate) break;
  }

  if (mainCandidate) return [mainCandidate];
  if (anyCandidate) return [anyCandidate];

  const fromMain = normalizeImageEntry(fallbacks.mainImage);
  if (fromMain) return [fromMain];

  if (fallbacks.imageUrl) {
    const fromReport = normalizeImageEntry({ url: fallbacks.imageUrl });
    if (fromReport) return [fromReport];
  }

  if (Array.isArray(fallbacks.existingImages) && fallbacks.existingImages.length > 0) {
    const preserved = fallbacks.existingImages.map(normalizeImageEntry).filter(Boolean);
    if (preserved.length) return preserved;
  }

  return [];
}

function extractEan(catalogItem, marketplaceId) {
  for (const set of catalogItem?.identifiers || []) {
    if (set.marketplaceId && set.marketplaceId !== marketplaceId) continue;
    for (const id of set.identifiers || []) {
      if (id.identifierType === 'EAN') return id.identifier;
      if (id.identifierType === 'GTIN' || id.identifierType === 'UPC') return id.identifier;
    }
  }
  return null;
}

function extractSalesRank(catalogItem, marketplaceId) {
  for (const set of catalogItem?.salesRanks || []) {
    if (set.marketplaceId && set.marketplaceId !== marketplaceId) continue;
    if (set.displayGroupRanks?.length) {
      const primary = set.displayGroupRanks[0];
      return { rank: primary.rank, title: primary.title, classificationId: null };
    }
    if (set.classificationRanks?.length) {
      const primary = set.classificationRanks[0];
      return {
        rank: primary.rank,
        title: primary.title,
        classificationId: primary.classificationId || null,
      };
    }
    if (set.ranks?.length) {
      const primary = set.ranks[0];
      return { rank: primary.rank, title: primary.title, classificationId: null };
    }
  }
  return null;
}

function reviveDatesInExtras(extras = {}) {
  const revived = { ...extras };
  if (typeof revived.feesLastSynced === 'string') {
    revived.feesLastSynced = new Date(revived.feesLastSynced);
  }
  if (typeof revived.existing?.inventoryManualOverrideAt === 'string') {
    revived.existing = {
      ...revived.existing,
      inventoryManualOverrideAt: new Date(revived.existing.inventoryManualOverrideAt),
    };
  }
  if (revived.listing) {
    revived.listing = {
      ...revived.listing,
      listingCreatedDate: revived.listing.listingCreatedDate
        ? new Date(revived.listing.listingCreatedDate)
        : null,
      listingLastUpdated: revived.listing.listingLastUpdated
        ? new Date(revived.listing.listingLastUpdated)
        : null,
    };
  }
  return revived;
}

function buildProductDocument(sellerId, fbaItem, catalogItem = null, extras = {}) {
  const normalizedExtras = reviveDatesInExtras(extras);
  const listingItem = normalizedExtras.listingItem || null;
  const listingSummary = getListingSummary(listingItem, normalizedExtras.marketplaceId);
  const details = fbaItem?.inventoryDetails || {};
  const fbaFulfillable = details.fulfillableQuantity ?? 0;
  const merchantQty = getMerchantQuantity(listingItem, normalizedExtras.marketplaceId);
  const fbaInventoryFields = inventoryFieldsFromFbaItem(fbaItem);
  const reserved = fbaInventoryFields.reservedQuantity;
  const inboundWorking = fbaInventoryFields.inboundWorkingQuantity;
  const inboundShipped = fbaInventoryFields.inboundShippedQuantity;
  const inboundReceiving = fbaInventoryFields.inboundReceivingQuantity;
  const inbound = fbaInventoryFields.inboundQuantity;
  const reservedPendingCustomerOrder = fbaInventoryFields.reservedPendingCustomerOrder;
  const reservedFcProcessing = fbaInventoryFields.reservedFcProcessing;
  const reservedPendingTransshipment = fbaInventoryFields.reservedPendingTransshipment;

  const catalogSummary = catalogItem?.summaries?.[0];
  const marketplaceId = normalizedExtras.marketplaceId || null;
  const listing = normalizedExtras.listing || {};
  const pricing = normalizedExtras.pricing || {};
  const fees = normalizedExtras.fees || {};
  const images = extractPrimaryImage(catalogItem, {
    mainImage: listing.mainImage || listingSummary?.mainImage || null,
    imageUrl: listing.imageUrl || null,
    existingImages: normalizedExtras.existing?.images || null,
  });

  const sku = fbaItem?.sellerSku || listingItem?.sku || listingSummary?.sku;
  const asin = fbaItem?.asin || listingSummary?.asin;
  // FBA inventory summaries do not always include a channel code. Falling back to
  // "DEFAULT" incorrectly maps to FBM and zeroes Available for AFN SKUs.
  const rawChannel =
    listing.fulfillmentChannel ||
    fbaItem?.fulfillmentChannelCode ||
    (fbaItem ? 'AMAZON_NA' : 'DEFAULT');
  const fulfillmentType =
    listing.fulfillmentType ||
    (fbaItem && !listing.fulfillmentType && !listing.fulfillmentChannel
      ? 'FBA'
      : normalizeFulfillmentType(rawChannel));
  // Product.inventory.fulfillmentChannel is a strict enum; coerce report/API
  // variants (AMAZON_US, empty, etc.) so bulkWrite validators cannot wipe a sync.
  const ALLOWED_CHANNELS = new Set(['DEFAULT', 'AFN', 'MFN', 'AMAZON_NA', 'AMAZON_EU']);
  let fulfillmentChannel = String(rawChannel || '').toUpperCase();
  if (!ALLOWED_CHANNELS.has(fulfillmentChannel)) {
    fulfillmentChannel =
      fulfillmentType === 'FBA' ? 'AMAZON_NA' : fulfillmentType === 'FBM' ? 'DEFAULT' : 'DEFAULT';
  }
  const availableQty = fulfillmentType === 'FBM' ? merchantQty : fbaFulfillable;
  const manualOverride = Boolean(normalizedExtras.existing?.inventoryManualOverrideAt);
  const manualQty = manualOverride
    ? Number(
        normalizedExtras.existing?.inventory?.fulfillableQuantity ??
          normalizedExtras.existing?.inventory?.quantity ??
          availableQty,
      )
    : availableQty;
  const syncedQty = manualOverride ? manualQty : availableQty;
  const syncedFulfillable =
    manualOverride
      ? manualQty
      : fulfillmentType === 'FBM'
        ? merchantQty
        : fbaFulfillable;

  const ean = marketplaceId ? extractEan(catalogItem, marketplaceId) : null;
  const salesRank = marketplaceId ? extractSalesRank(catalogItem, marketplaceId) : null;

  const price = listing.price?.amount > 0 ? listing.price : money(0);

  return {
    sellerId,
    asin,
    sku,
    fnSku: fbaItem?.fnSku || listingSummary?.fnSku || null,
    ean,
    title:
      listingSummary?.itemName ||
      catalogSummary?.itemName ||
      fbaItem?.productName ||
      sku ||
      'Unknown',
    price: mergeMoneyField(normalizedExtras.existing?.price, price),
    shippingCost: mergeMoneyField(normalizedExtras.existing?.shippingCost, listing.shippingCost),
    minimumPrice: mergeMoneyField(normalizedExtras.existing?.minimumPrice, listing.minimumPrice),
    maximumPrice: mergeMoneyField(normalizedExtras.existing?.maximumPrice, listing.maximumPrice),
    businessPrice: mergeMoneyField(normalizedExtras.existing?.businessPrice, listing.businessPrice),
    lowestPrice: pricing.lowestPrice || money(0),
    featuredOffer: pricing.featuredOffer || { isBuyBox: false, price: money(0) },
    fees: {
      totalFees: fees.totalFees || money(0),
      fbaFee: fees.fbaFee || money(0),
      breakdown: fees.breakdown || [],
    },
    inventory: {
      quantity: syncedQty,
      totalQuantity: fbaItem?.totalQuantity ?? syncedQty,
      fulfillableQuantity: syncedFulfillable,
      reservedQuantity: reserved,
      inboundQuantity: inbound,
      unfulfillableQuantity: fbaInventoryFields.unfulfillableQuantity,
      inboundWorkingQuantity: inboundWorking,
      inboundShippedQuantity: inboundShipped,
      inboundReceivingQuantity: inboundReceiving,
      reservedPendingCustomerOrder: reservedPendingCustomerOrder,
      reservedPendingTransshipment: reservedPendingTransshipment,
      reservedFcProcessing: reservedFcProcessing,
      unfulfillableCustomerDamaged: fbaInventoryFields.unfulfillableCustomerDamaged,
      unfulfillableWarehouseDamaged: fbaInventoryFields.unfulfillableWarehouseDamaged,
      unfulfillableDistributorDamaged: fbaInventoryFields.unfulfillableDistributorDamaged,
      unfulfillableCarrierDamaged: fbaInventoryFields.unfulfillableCarrierDamaged,
      unfulfillableDefective: fbaInventoryFields.unfulfillableDefective,
      unfulfillableExpired: fbaInventoryFields.unfulfillableExpired,
      fulfillmentChannel,
    },
    fulfillmentType,
    images,
    category:
      catalogSummary?.productCategory?.displayName ||
      catalogSummary?.browseClassification?.displayName ||
      null,
    brand: catalogSummary?.brand || catalogSummary?.brandName || null,
    condition: mapConditionType(listingSummary?.conditionType) || fbaItem?.condition || 'New',
    listingStatus: listing.listingStatus || null,
    isListedOnAmazon: true,
    status: applyInventoryToListingStatus(
      listing.status ||
        mapAmazonListingStatus(null, listing.listingStatus, {
          offerClosed: Boolean(listing.offerClosed),
        }),
      // syncedFulfillable is set above in this builder; fall back to existing qty.
      typeof syncedFulfillable === 'number'
        ? syncedFulfillable
        : getSellableQuantity(normalizedExtras.existing?.inventory),
    ),
    salesRank: salesRank || undefined,
    // Keep Sales & Traffic metrics across inventory rebuilds — they come from a
    // separate report and are not present on listings/FBA payloads.
    unitsSold:
      normalizedExtras.existing?.unitsSold != null
        ? Number(normalizedExtras.existing.unitsSold) || 0
        : null,
    pageViews:
      normalizedExtras.existing?.pageViews != null
        ? Number(normalizedExtras.existing.pageViews) || 0
        : null,
    listingCreatedDate:
      coerceValidDate(listing.listingCreatedDate) ||
      coerceValidDate(normalizedExtras.existing?.listingCreatedDate) ||
      null,
    lastSynced: new Date(),
    feesLastSynced: normalizedExtras.feesLastSynced || new Date(),
    // Manage Inventory last-updated is resolved in listingItemParse / listingDatesSync
    // (quantity-change semantics) — not FBA inventory lastUpdatedTime or raw API dates.
    lastUpdatedTime:
      coerceValidDate(listing.listingLastUpdated) ||
      coerceValidDate(normalizedExtras.existing?.lastUpdatedTime) ||
      null,
    inventoryManualOverrideAt: normalizedExtras.existing?.inventoryManualOverrideAt || null,
    updatedAt: new Date(),
  };
}

module.exports = {
  buildProductDocument,
  extractPrimaryImage,
  extractEan,
  extractSalesRank,
};
