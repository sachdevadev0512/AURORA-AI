const mongoose = require('mongoose');
const {
  applyListingFilter,
  applyReportFilter,
  SELLABLE_INVENTORY_GT_ZERO,
} = require('./productListingUtils');
const { buildCaseInsensitiveRegex } = require('./regexSearch');

const ALLOWED_SORT_FIELDS = [
  'title',
  'sku',
  'asin',
  'status',
  'listingStatus',
  'fulfillmentType',
  'inventory.fulfillableQuantity',
  'price.amount',
  'unitsSold',
  'pageViews',
  'salesRank.rank',
  'lastSynced',
  'updatedAt',
  'lastUpdatedTime',
  'listingCreatedDate',
];

function buildProductQueryFromRequest(req) {
  const sellerIdRaw = req.user?._id || req.user?.id;
  const sellerId =
    sellerIdRaw instanceof mongoose.Types.ObjectId
      ? sellerIdRaw
      : new mongoose.Types.ObjectId(String(sellerIdRaw));
  const andClauses = [{ sellerId }];

  if (req.query.search) {
    const search = String(req.query.search).trim();
    if (search) {
      const searchRegex = buildCaseInsensitiveRegex(search);
      if (searchRegex) {
        andClauses.push({
          $or: [
            { title: searchRegex },
            { sku: searchRegex },
            { asin: searchRegex },
            { fnSku: searchRegex },
            { ean: searchRegex },
            { brand: searchRegex },
          ],
        });
      }
    }
  }

  // A "report" filter (used for CSV downloads) is self-contained and takes
  // precedence over the interactive listing/fulfillment filters.
  const reportApplied = applyReportFilter(andClauses, req.query.report);

  const listingParam = String(req.query.listing || 'listed').toLowerCase();
  let stockParam = String(req.query.stock || '');

  // Active and Out of Stock are mutually exclusive (Seller Central style).
  if (listingParam === 'active' && stockParam === 'outOfStock') {
    stockParam = '';
  }
  if (
    (listingParam === 'outofstock' || listingParam === 'out_of_stock') &&
    stockParam === 'inStock'
  ) {
    stockParam = '';
  }

  if (!reportApplied) {
    if (req.query.status) {
      andClauses.push({ status: req.query.status });
    } else {
      applyListingFilter(andClauses, req.query.listing);
    }

    const fulfillment = String(req.query.fulfillment || '').toUpperCase();
    if (fulfillment === 'FBA' || fulfillment === 'FBM') {
      andClauses.push({ fulfillmentType: fulfillment });
    }
  }

  if (stockParam === 'inStock') {
    andClauses.push({
      $or: SELLABLE_INVENTORY_GT_ZERO,
    });
  } else if (stockParam === 'outOfStock') {
    // Prefer status when backfilled; also match zero available for legacy rows.
    andClauses.push({
      $or: [
        { status: 'Out of Stock' },
        {
          $and: [
            { status: { $nin: ['Closed', 'Incomplete'] } },
            { $nor: SELLABLE_INVENTORY_GT_ZERO },
          ],
        },
      ],
    });
  }

  return andClauses.length === 1 ? andClauses[0] : { $and: andClauses };
}

function resolveProductSort(req) {
  const sortBy = req.query.sortBy || 'updatedAt';
  const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
  const sortField = ALLOWED_SORT_FIELDS.includes(sortBy) ? sortBy : 'updatedAt';
  return { sortField, sortOrder };
}

module.exports = {
  ALLOWED_SORT_FIELDS,
  buildProductQueryFromRequest,
  resolveProductSort,
};
