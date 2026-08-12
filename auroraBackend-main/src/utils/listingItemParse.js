const { deriveProductStatus } = require('./productListingUtils');
const { resolveManageInventoryLastUpdated } = require('./listingLastUpdatedResolver');
const { pickMarketplaceRow } = require('./marketplaceRow');
const {
  extractOfferPrice,
  extractListingBoundPrices,
  listingAttrValue,
} = require('./listingPriceParser');

function money(amount, currency = 'USD') {
  const parsed = Number(amount);
  return {
    amount: Number.isFinite(parsed) ? parsed : 0,
    currency: currency || 'USD',
  };
}

function normalizeFulfillmentType(channel) {
  const code = String(channel || '').toUpperCase();
  if (code === 'AFN' || code.startsWith('AMAZON')) return 'FBA';
  if (code === 'MFN' || code === 'DEFAULT' || code === 'MERCHANT') return 'FBM';
  return 'UNKNOWN';
}

function mapConditionType(conditionType) {
  if (conditionType == null || conditionType === '') return 'New';
  const raw = String(conditionType).trim();
  const aliases = {
    new_new: 'New',
    NewItem: 'New',
    new: 'New',
    '11': 'New',
    new_open_box: 'New - Open Box',
    new_oem: 'New - OEM',
    refurbished_refurbished: 'Refurbished',
    used_like_new: 'Used - Like New',
    used_very_good: 'Used - Very Good',
    used_good: 'Used - Good',
    used_acceptable: 'Used - Acceptable',
    collectible_like_new: 'Collectible - Like New',
    collectible_very_good: 'Collectible - Very Good',
    collectible_good: 'Collectible - Good',
    collectible_acceptable: 'Collectible - Acceptable',
  };
  if (aliases[raw]) return aliases[raw];
  const lower = raw.toLowerCase();
  if (aliases[lower]) return aliases[lower];
  if (/^new(_new)?$/i.test(raw)) return 'New';
  // Avoid "new new" from underscore splits of unknown new_* enums
  return raw
    .replace(/_/g, ' ')
    .replace(/\b(\w+)\s+\1\b/gi, '$1')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getListingSummary(listingItem, marketplaceId) {
  return pickMarketplaceRow(listingItem?.summaries, marketplaceId);
}

function getMerchantQuantity(listingItem, marketplaceId) {
  const row = pickMarketplaceRow(listingItem?.fulfillmentAvailability, marketplaceId);
  const qty = row?.quantity;
  return Number.isFinite(Number(qty)) ? Number(qty) : 0;
}

function parseListingItem(listingItem, marketplaceId) {
  if (!listingItem) return {};
  const summary = pickMarketplaceRow(listingItem.summaries, marketplaceId);
  const attributes = listingItem.attributes || {};
  const fulfillment = pickMarketplaceRow(listingItem.fulfillmentAvailability, marketplaceId);

  const { amount: priceAmount, currency: attrCurrency } = extractOfferPrice(attributes, marketplaceId);
  let price = priceAmount;
  let currency = attrCurrency;

  if (!price && listingItem.offers?.length) {
    const offer = pickMarketplaceRow(listingItem.offers, marketplaceId);
    price = offer?.price?.amount ?? offer?.price?.Amount ?? 0;
    currency = offer?.price?.currencyCode ?? offer?.price?.CurrencyCode ?? currency;
  }

  const shippingAmount =
    listingAttrValue(attributes, 'shipping_cost', marketplaceId) ||
    listingAttrValue(attributes, 'merchant_shipping_group', marketplaceId) ||
    0;

  const fulfillmentChannel =
    fulfillment?.fulfillmentChannelCode || summary?.fulfillmentType || null;

  const listingStatuses = summary?.status || [];
  const listingStatus = Array.isArray(listingStatuses)
    ? listingStatuses.join(', ')
    : summary?.status || null;
  const status = deriveProductStatus({
    listingStatus,
    attributes,
    marketplaceId,
  });

  const boundPrices = extractListingBoundPrices(attributes, marketplaceId, listingItem.offers);
  const priceCurrency = boundPrices.currency || currency;
  const mainImage = summary?.mainImage || null;

  return {
    listingStatus,
    status,
    mainImage,
    listingCreatedDate: summary?.createdDate ? new Date(summary.createdDate) : null,
    listingLastUpdated: resolveManageInventoryLastUpdated({
      createdDate: summary?.createdDate,
      listingsApiLastUpdated: summary?.lastUpdatedDate,
      listingItem,
      marketplaceId,
    }),
    price: money(price, currency),
    shippingCost: money(shippingAmount, currency),
    minimumPrice: money(boundPrices.minimumPrice, priceCurrency),
    maximumPrice: money(boundPrices.maximumPrice, priceCurrency),
    businessPrice: money(boundPrices.businessPrice, priceCurrency),
    fulfillmentChannel,
    fulfillmentType: normalizeFulfillmentType(fulfillmentChannel),
  };
}

function fbaReservedForSellerCentral(fbaItem) {
  const { sellerCentralReserved } = require('./fbaInventoryFields');
  return sellerCentralReserved(fbaItem?.inventoryDetails?.reservedQuantity || {});
}

function fbaInboundTotal(fbaItem) {
  const details = fbaItem?.inventoryDetails || {};
  return (
    (details.inboundWorkingQuantity ?? 0) +
    (details.inboundShippedQuantity ?? 0) +
    (details.inboundReceivingQuantity ?? 0)
  );
}

function isUnchangedProduct(fbaItem, listingItem, existing, marketplaceId) {
  if (!existing) return false;

  const listingSummary = getListingSummary(listingItem, marketplaceId);
  const newAsin = fbaItem?.asin || listingSummary?.asin || null;
  if (newAsin && existing.asin !== newAsin) return false;

  if (fbaItem) {
    const fulfillable = fbaItem.inventoryDetails?.fulfillableQuantity ?? 0;
    const reserved = fbaReservedForSellerCentral(fbaItem);
    const inbound = fbaInboundTotal(fbaItem);
    const unfulfillable =
      fbaItem.inventoryDetails?.unfulfillableQuantity?.totalUnfulfillableQuantity ?? 0;
    const total = fbaItem.totalQuantity ?? fulfillable + reserved + inbound + unfulfillable;

    if ((existing.inventory?.fulfillableQuantity ?? 0) !== fulfillable) return false;
    if ((existing.inventory?.reservedQuantity ?? 0) !== reserved) return false;
    if ((existing.inventory?.inboundQuantity ?? 0) !== inbound) return false;
    if ((existing.inventory?.unfulfillableQuantity ?? 0) !== unfulfillable) return false;
    if ((existing.inventory?.totalQuantity ?? 0) !== total) return false;
    return true;
  }

  const merchantQty = getMerchantQuantity(listingItem, marketplaceId);
  return (existing.inventory?.fulfillableQuantity ?? 0) === merchantQty;
}

function hasValidListingDate(value) {
  if (value == null || value === '') return false;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === 'object' && !(value instanceof Date)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
}

/**
 * Date-only $set when inventory sync would otherwise skip a SKU that is still
 * missing listingCreatedDate / lastUpdatedTime (or Amazon has a newer last update).
 */
function buildListingDatePatch(existing, listing, fbaItem) {
  if (!existing) return null;
  const patch = {};

  const created = listing?.listingCreatedDate;
  if (!hasValidListingDate(existing.listingCreatedDate) && hasValidListingDate(created)) {
    patch.listingCreatedDate = created instanceof Date ? created : new Date(created);
  }

  const incomingLast =
    listing?.listingLastUpdated || null;
  if (hasValidListingDate(incomingLast)) {
    const next = incomingLast instanceof Date ? incomingLast : new Date(incomingLast);
    if (!hasValidListingDate(existing.lastUpdatedTime)) {
      patch.lastUpdatedTime = next;
    } else {
      const prev = new Date(existing.lastUpdatedTime);
      if (next.getTime() > prev.getTime()) {
        patch.lastUpdatedTime = next;
      }
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function reportItemChanged(existing, listing, fbaItem, listingItem, marketplaceId) {
  if (!existing) return true;

  const summary = getListingSummary(listingItem, marketplaceId);
  const newAsin = fbaItem?.asin || summary?.asin || null;
  if (newAsin && existing.asin !== newAsin) return true;

  if (listing.status && existing.status !== listing.status) return true;

  // Force a rewrite when images were never populated (catalog/mainImage skipped).
  if (!existing.images?.length) return true;

  // Force a rewrite when Amazon listing dates are still missing on the stored row.
  if (
    !hasValidListingDate(existing.listingCreatedDate) &&
    hasValidListingDate(listing?.listingCreatedDate)
  ) {
    return true;
  }
  if (
    !hasValidListingDate(existing.lastUpdatedTime) &&
    hasValidListingDate(listing?.listingLastUpdated)
  ) {
    return true;
  }

  const newPrice = Number(listing.price?.amount || 0);
  const oldPrice = Number(existing.price?.amount || 0);
  if (Math.abs(newPrice - oldPrice) > 0.001) return true;

  const newCurrency = listing.price?.currency;
  if (newCurrency && existing.price?.currency && newCurrency !== existing.price.currency) {
    return true;
  }

  const fulfillable = fbaItem
    ? fbaItem.inventoryDetails?.fulfillableQuantity ?? 0
    : getMerchantQuantity(listingItem, marketplaceId);
  if ((existing.inventory?.fulfillableQuantity ?? 0) !== fulfillable) return true;

  if (fbaItem) {
    if ((existing.inventory?.reservedQuantity ?? 0) !== fbaReservedForSellerCentral(fbaItem)) {
      return true;
    }
    if ((existing.inventory?.inboundQuantity ?? 0) !== fbaInboundTotal(fbaItem)) return true;
    const unfulfillable =
      fbaItem.inventoryDetails?.unfulfillableQuantity?.totalUnfulfillableQuantity ?? 0;
    if ((existing.inventory?.unfulfillableQuantity ?? 0) !== unfulfillable) return true;
    if (
      fbaItem.totalQuantity != null &&
      (existing.inventory?.totalQuantity ?? 0) !== fbaItem.totalQuantity
    ) {
      return true;
    }
  }

  return false;
}

module.exports = {
  money,
  normalizeFulfillmentType,
  mapConditionType,
  getListingSummary,
  getMerchantQuantity,
  parseListingItem,
  isUnchangedProduct,
  reportItemChanged,
  buildListingDatePatch,
  hasValidListingDate,
};
