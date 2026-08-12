const REMOVED_LISTING_STATUSES = /^(Removed from Seller Central|No Seller Central listing)$/i;
const AMAZON_WAREHOUSE_SKU = /^amzn\.gr\./i;

function isBuyableListingStatus(listingStatus) {
  return String(listingStatus || '').toUpperCase().includes('BUYABLE');
}

/** Sellable/available units used for Active vs Out of Stock (not reserved). */
function getSellableQuantity(inventory = null) {
  if (inventory == null || typeof inventory !== 'object') return 0;
  const fulfillable = Number(inventory.fulfillableQuantity);
  if (Number.isFinite(fulfillable)) return Math.max(0, fulfillable);
  const quantity = Number(inventory.quantity);
  if (Number.isFinite(quantity)) return Math.max(0, quantity);
  return 0;
}

/**
 * Parse Seller Central / All Listings Report `open-date` values such as
 * `2025-10-19 05:04:43 PDT` or `08/07/2016 10:12:40 BST`.
 */
function parseAmazonOpenDate(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw;
  }
  if (typeof raw === 'object') return null;

  const text = String(raw).trim();
  if (!text) return null;

  const tzOffsets = {
    PDT: '-07:00',
    PST: '-08:00',
    MDT: '-06:00',
    MST: '-07:00',
    CDT: '-05:00',
    CST: '-06:00',
    EDT: '-04:00',
    EST: '-05:00',
    AKDT: '-08:00',
    AKST: '-09:00',
    HST: '-10:00',
    GMT: '+00:00',
    UTC: '+00:00',
    BST: '+01:00',
    IST: '+05:30',
  };

  const isoish = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\s+([A-Za-z]{2,5}))?$/,
  );
  if (isoish) {
    const [, y, mo, d, h, mi, s, tz] = isoish;
    const offset = tzOffsets[String(tz || '').toUpperCase()] || 'Z';
    const parsed = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const slash = text.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{2}):(\d{2}):(\d{2})(?:\s+([A-Za-z]{2,5}))?$/,
  );
  if (slash) {
    const [, a, b, y, h, mi, s, tz] = slash;
    const offset = tzOffsets[String(tz || '').toUpperCase()] || 'Z';
    // Prefer MDY for US marketplaces when ambiguous; day>12 forces DMY.
    const first = Number(a);
    const second = Number(b);
    const month = first > 12 ? second : first;
    const day = first > 12 ? first : second;
    const parsed = new Date(
      `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${h}:${mi}:${s}${offset}`,
    );
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const fallback = new Date(text);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function coerceValidDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) {
    // Guard against corrupt Mongo values like `{}`.
    if (!Object.keys(value).length) return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Seller Central style: Active requires available inventory. Zero available on an
 * otherwise-Active/BUYABLE listing is Out of Stock (under Inactive in SC).
 * Closed / Incomplete / suppressed Inactive are unchanged.
 */
function applyInventoryToListingStatus(baseStatus, availableQuantity = 0) {
  const status = String(baseStatus || 'Inactive');
  if (status === 'Closed' || status === 'Incomplete') return status;

  const qty = Math.max(0, Number(availableQuantity) || 0);
  if (qty > 0) {
    if (status === 'Out of Stock') return 'Active';
    return status;
  }

  if (status === 'Active' || status === 'Out of Stock') return 'Out of Stock';
  return status;
}

/**
 * Seller Central "Closed" = purchasable offer sale window ended (end_at in the past)
 * or the offer was removed. Distinct from Inactive (suppressed / OOS / blocked with
 * an open-ended offer). Merchant listings reports collapse both to "Inactive".
 */
function isPurchasableOfferClosed(attributes, marketplaceId = null) {
  if (attributes == null || typeof attributes !== 'object') return false;

  const offers = attributes.purchasable_offer;
  if (!Array.isArray(offers) || offers.length === 0) {
    // Attributes were loaded but there is no live offer → Closed in SC.
    return Object.prototype.hasOwnProperty.call(attributes, 'purchasable_offer')
      ? true
      : false;
  }

  const scoped = offers.filter(
    (offer) => !marketplaceId || !offer.marketplace_id || offer.marketplace_id === marketplaceId,
  );
  const list = scoped.length ? scoped : offers;
  const now = Date.now();

  return list.every((offer) => {
    const endRaw = offer?.end_at?.value ?? offer?.end_at;
    if (endRaw == null || endRaw === '') return false;
    const endedAt = new Date(endRaw).getTime();
    return Number.isFinite(endedAt) && endedAt <= now;
  });
}

/**
 * Map Amazon merchant-listings report `status` + optional Listings Items signals
 * to Aurora Product.status. Seller Central UI: Active / Inactive / Incomplete / Closed.
 */
function mapAmazonListingStatus(rawStatus, listingStatus = null, options = {}) {
  const text = String(rawStatus || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ');

  let mapped;
  if (text === 'active' || text === 'open') mapped = 'Active';
  else if (text === 'incomplete') mapped = 'Incomplete';
  else if (text === 'closed') mapped = 'Closed';
  else if (text === 'out of stock' || text === 'outofstock') mapped = 'Out of Stock';
  else if (isBuyableListingStatus(listingStatus)) mapped = 'Active';
  else if (options.offerClosed === true) mapped = 'Closed';
  else if (text === 'inactive' || text === 'cancelled' || text === 'canceled') {
    mapped = 'Inactive';
  } else {
    mapped = 'Inactive';
  }

  if (options.availableQuantity != null) {
    return applyInventoryToListingStatus(mapped, options.availableQuantity);
  }
  return mapped;
}

/**
 * Full status derivation when listing attributes / inventory may be available.
 */
function deriveProductStatus({
  rawReportStatus = null,
  listingStatus = null,
  attributes = null,
  marketplaceId = null,
  availableQuantity = null,
} = {}) {
  const offerClosed = isPurchasableOfferClosed(attributes, marketplaceId);
  return mapAmazonListingStatus(rawReportStatus, listingStatus, {
    offerClosed,
    availableQuantity,
  });
}

function isRemovedListingStatus(listingStatus) {
  return REMOVED_LISTING_STATUSES.test(String(listingStatus || '').trim());
}

function isAmazonWarehouseSku(sku) {
  return AMAZON_WAREHOUSE_SKU.test(String(sku || '').trim());
}

/** No Seller Central listing metadata — only FBA/warehouse history may remain. */
function isStaleWithoutListingMetadata(product) {
  return (
    product?.status === 'Inactive' &&
    !product.listingStatus &&
    !product.listingCreatedDate
  );
}

/** Stale rows that are not real Seller Central listings. */
function isLegacyRemovedProduct(product) {
  if (!product) return false;
  if (product.isListedOnAmazon === false) return true;
  if (isRemovedListingStatus(product.listingStatus)) return true;
  return isStaleWithoutListingMetadata(product);
}

/** Mongo clause: hide SKUs deleted from Seller Central, keep active + inactive still on SC. */
function buildExcludeRemovedClause() {
  return {
    $nor: [
      { isListedOnAmazon: false },
      { listingStatus: REMOVED_LISTING_STATUSES },
      {
        status: 'Inactive',
        listingStatus: null,
        listingCreatedDate: null,
      },
    ],
  };
}

function buildRemovedOnlyClause() {
  return {
    $or: [
      { isListedOnAmazon: false },
      { listingStatus: REMOVED_LISTING_STATUSES },
      {
        status: 'Inactive',
        listingStatus: null,
        listingCreatedDate: null,
      },
    ],
  };
}

const SELLABLE_INVENTORY_GT_ZERO = [
  { 'inventory.fulfillableQuantity': { $gt: 0 } },
  { 'inventory.quantity': { $gt: 0 } },
];

function applyListingFilter(andClauses, listingParam) {
  const listing = String(listingParam || 'listed').toLowerCase();

  if (listing === 'all') {
    return;
  }

  if (listing === 'listed') {
    andClauses.push(buildExcludeRemovedClause());
    return;
  }

  if (listing === 'active') {
    // Active in SC implies available inventory — never combine with OOS.
    andClauses.push({
      status: 'Active',
      ...buildExcludeRemovedClause(),
    });
    andClauses.push({ $or: SELLABLE_INVENTORY_GT_ZERO });
    return;
  }

  if (listing === 'outofstock' || listing === 'out_of_stock') {
    andClauses.push({
      status: 'Out of Stock',
      isListedOnAmazon: { $ne: false },
      $nor: [{ listingStatus: REMOVED_LISTING_STATUSES }],
    });
    return;
  }

  if (listing === 'inactive') {
    andClauses.push({
      status: 'Inactive',
      isListedOnAmazon: { $ne: false },
      listingStatus: { $nin: [null, ''] },
      $nor: [{ listingStatus: REMOVED_LISTING_STATUSES }],
    });
    return;
  }

  if (listing === 'closed') {
    andClauses.push({
      status: 'Closed',
      isListedOnAmazon: { $ne: false },
      $nor: [{ listingStatus: REMOVED_LISTING_STATUSES }],
    });
    return;
  }

  if (listing === 'removed') {
    andClauses.push(buildRemovedOnlyClause());
  }
}

/** Report filter options exposed to the user when downloading the inventory CSV. */
const REPORT_FILTERS = ['active', 'inactive', 'fba', 'fbm', 'closed', 'outofstock'];

/**
 * Apply a self-contained "Report Filter" (used for CSV downloads).
 * Returns true when a known report was applied so callers can skip the
 * interactive listing/fulfillment filters.
 */
function applyReportFilter(andClauses, reportParam) {
  const report = String(reportParam || '').toLowerCase();

  switch (report) {
    case 'active':
      applyListingFilter(andClauses, 'active');
      return true;
    case 'inactive':
      applyListingFilter(andClauses, 'inactive');
      return true;
    case 'outofstock':
    case 'out_of_stock':
      applyListingFilter(andClauses, 'outofstock');
      return true;
    case 'closed':
      applyListingFilter(andClauses, 'closed');
      return true;
    case 'fba':
      andClauses.push({ fulfillmentType: 'FBA' }, buildExcludeRemovedClause());
      return true;
    case 'fbm':
      andClauses.push({ fulfillmentType: 'FBM' }, buildExcludeRemovedClause());
      return true;
    default:
      return false;
  }
}

module.exports = {
  REMOVED_LISTING_STATUSES,
  AMAZON_WAREHOUSE_SKU,
  SELLABLE_INVENTORY_GT_ZERO,
  isBuyableListingStatus,
  getSellableQuantity,
  parseAmazonOpenDate,
  coerceValidDate,
  applyInventoryToListingStatus,
  isPurchasableOfferClosed,
  mapAmazonListingStatus,
  deriveProductStatus,
  isRemovedListingStatus,
  isAmazonWarehouseSku,
  isStaleWithoutListingMetadata,
  isLegacyRemovedProduct,
  buildExcludeRemovedClause,
  buildRemovedOnlyClause,
  applyListingFilter,
  applyReportFilter,
  REPORT_FILTERS,
};
