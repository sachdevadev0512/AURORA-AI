const Product = require('../models/Product');
const Joi = require('joi');
const { reconcileSellerListings, restoreLiveListingsMarkedRemoved } = require('../services/listingReconcileService');
const { resolveProductReferralFee } = require('../utils/productFeeParser');
const { parseExportLimit, exportLimitExceeded } = require('../utils/exportLimits');
const readResponseCache = require('../utils/readResponseCache');
const {
  buildEntityTag,
  parseIfMatchHeader,
  applyIfMatchFilter,
} = require('../utils/optimisticConcurrency');
const {
  buildProductQueryFromRequest,
  resolveProductSort,
} = require('../utils/productQueryBuilder');

const PRODUCT_LIST_CACHE_NS = 'products:list';

async function fetchSortedProducts(query, sortField, sortOrder, { skip = 0, limit } = {}) {
  const { products } = await fetchPaginatedProducts(query, sortField, sortOrder, { skip, limit });
  return products;
}

async function fetchPaginatedProducts(query, sortField, sortOrder, { skip = 0, limit } = {}) {
  let dataPipeline;
  if (sortField === 'inventory.fulfillableQuantity') {
    dataPipeline = [
      {
        $addFields: {
          sortFulfillable: {
            $ifNull: ['$inventory.fulfillableQuantity', { $ifNull: ['$inventory.quantity', 0] }],
          },
        },
      },
      { $sort: { sortFulfillable: sortOrder, title: 1 } },
      { $project: { sortFulfillable: 0 } },
    ];
  } else {
    dataPipeline = [{ $sort: { [sortField]: sortOrder, title: 1 } }];
  }

  if (skip > 0) dataPipeline.push({ $skip: skip });
  if (limit != null) dataPipeline.push({ $limit: limit });

  const [result] = await Product.aggregate([
    { $match: query },
    {
      $facet: {
        data: dataPipeline,
        total: [{ $count: 'count' }],
      },
    },
  ]);

  return {
    products: result?.data || [],
    total: result?.total?.[0]?.count ?? 0,
  };
}

function csvEscape(value) {
  const str = value == null ? '' : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

function formatMoneyField(moneyValue) {
  if (!moneyValue || moneyValue.amount == null) return '';
  const amount = Number(moneyValue.amount);
  if (!Number.isFinite(amount)) return '';
  return `${moneyValue.currency || 'USD'} ${amount.toFixed(2)}`;
}

function formatDateField(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function productToCsvRow(product) {
  const fulfillable =
    product.inventory?.fulfillableQuantity ?? product.inventory?.quantity ?? 0;
  const buyBox = product.featuredOffer?.isBuyBox
    ? `Yes (${formatMoneyField(product.featuredOffer.price)})`
    : 'No';

  return [
    product.title,
    product.asin,
    product.sku,
    product.ean,
    product.fnSku,
    product.condition,
    product.listingStatus,
    product.status,
    formatDateField(product.listingCreatedDate),
    formatDateField(product.lastUpdatedTime),
    product.unitsSold ?? '',
    product.pageViews ?? '',
    product.salesRank?.rank ?? '',
    product.salesRank?.title ?? '',
    fulfillable,
    product.inventory?.inboundQuantity ?? 0,
    product.inventory?.reservedQuantity ?? 0,
    product.inventory?.unfulfillableQuantity ?? 0,
    formatMoneyField(product.price),
    formatMoneyField(product.shippingCost),
    formatMoneyField(product.minimumPrice),
    formatMoneyField(product.maximumPrice),
    formatMoneyField(product.businessPrice),
    formatMoneyField(product.lowestPrice),
    buyBox,
    formatMoneyField(resolveProductReferralFee(product.fees)),
    formatMoneyField(product.fees?.fbaFee),
    formatMoneyField(product.fees?.totalFees),
    product.fulfillmentType || product.inventory?.fulfillmentChannel || '',
    product.brand,
    product.category,
    formatDateField(product.lastSynced),
  ];
}

const PRODUCT_CSV_HEADERS = [
  'Title',
  'ASIN',
  'SKU',
  'EAN',
  'FNSKU',
  'Condition',
  'Listing Status',
  'Status',
  'Created Date',
  'Last Updated Date',
  'Units Sold (30 days)',
  'Page Views (30 days)',
  'Sales Rank (BSR)',
  'Sales Rank Category',
  'Available Inventory',
  'Inbound Inventory',
  'Reserved Inventory',
  'Unfulfillable Inventory',
  'Price',
  'Shipping Cost',
  'Minimum Price',
  'Maximum Price',
  'Business Price',
  'Lowest Price',
  'Featured Offer (Buy Box)',
  'Referral Fee',
  'FBA Fee',
  'Total Fees',
  'Fulfillment Type',
  'Brand',
  'Category',
  'Last Synced',
];

// @desc    Get all products for a user
// @route   GET /api/products
// @access  Private
const getProducts = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const startIndex = (page - 1) * limit;
    const query = buildProductQueryFromRequest(req);
    const { sortField, sortOrder } = resolveProductSort(req);
    const cacheKey = JSON.stringify({
      page,
      limit,
      sortField,
      sortOrder,
      query: req.query,
    });
    const cached = readResponseCache.get(
      PRODUCT_LIST_CACHE_NS,
      req.user._id,
      cacheKey,
    );

    let products;
    let total;
    if (cached) {
      products = cached.products;
      total = cached.total;
    } else {
      const pageResult = await fetchPaginatedProducts(query, sortField, sortOrder, {
        skip: startIndex,
        limit,
      });
      products = pageResult.products;
      total = pageResult.total;
      readResponseCache.set(PRODUCT_LIST_CACHE_NS, req.user._id, cacheKey, {
        products,
        total,
      });
    }

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.status(200).json({
      success: true,
      count: products.length,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      },
      data: products,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Export products inventory report as CSV
// @route   GET /api/products/export
// @access  Private
const exportProducts = async (req, res, next) => {
  try {
    const query = buildProductQueryFromRequest(req);
    const { sortField, sortOrder } = resolveProductSort(req);
    const exportLimit = parseExportLimit(
      process.env.PRODUCT_EXPORT_MAX_ROWS || process.env.EXPORT_MAX_ROWS,
      0,
    );
    const fetchOptions = exportLimit > 0 ? { limit: exportLimit } : {};
    const products = await fetchSortedProducts(query, sortField, sortOrder, fetchOptions);

    if (exportLimitExceeded(products.length, exportLimit)) {
      return res.status(400).json({
        success: false,
        error: `Export would include ${products.length} product(s), which exceeds the limit of ${exportLimit}. Narrow your filters or raise PRODUCT_EXPORT_MAX_ROWS.`,
      });
    }

    if (products.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No products available to export for the current filters.',
      });
    }

    const csvRows = products.map((product) => productToCsvRow(product).map(csvEscape).join(','));
    const csvContent = [PRODUCT_CSV_HEADERS.map(csvEscape).join(','), ...csvRows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=inventory-report-${new Date().toISOString().split('T')[0]}.csv`
    );
    res.status(200).send(csvContent);
  } catch (error) {
    next(error);
  }
};

// @desc    Get single product
// @route   GET /api/products/:id
// @access  Private
const getProduct = async (req, res, next) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      sellerId: req.user._id,
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        error: 'Product not found',
      });
    }

    if (process.env.PRODUCT_FEE_LIVE_SYNC_ENABLED !== 'false' && req.user?.amazonRefreshToken) {
      const { refreshProductFeesAndNotify } = require('../services/productFeeNotificationService');
      setImmediate(() => {
        refreshProductFeesAndNotify(req.user, product, { notify: true }).catch((err) => {
          console.warn(`[ProductFees] Live check on view ${product.asin}:`, err.message);
        });
      });
    }

    const etag = buildEntityTag(product.updatedAt);
    if (etag) res.set('ETag', etag);

    res.status(200).json({
      success: true,
      data: product,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Sync products from Amazon (background job)
// @route   POST /api/products/sync
// @access  Private
const syncProducts = async (req, res, next) => {
  try {
    const { inventorySyncManager } = require('../services/inventorySyncService');
    const result = await inventorySyncManager.start(req.user._id);
    res.status(202).json(result);
  } catch (error) {
    if (error.code === 'SP_NOT_CONNECTED') {
      return res.status(400).json({ success: false, error: error.message });
    }
    if (error.code === 'SELLER_ID_REQUIRED') {
      return res.status(400).json({ success: false, error: error.message });
    }
    next(error);
  }
};

const getInventorySyncStatus = async (req, res, next) => {
  try {
    const { inventorySyncManager } = require('../services/inventorySyncService');
    const status = await inventorySyncManager.getStatus(req.user._id);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.status(200).json({ success: true, ...status });
  } catch (error) {
    next(error);
  }
};

const stopInventorySync = async (req, res, next) => {
  try {
    const { inventorySyncManager } = require('../services/inventorySyncService');
    const result = await inventorySyncManager.stop(req.user._id);
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
};

// @desc    Update product
// @route   PUT /api/products/:id
// @access  Private
const updateProduct = async (req, res, next) => {
  try {
    const schema = Joi.object({
      title: Joi.string(),
      price: Joi.object({
        amount: Joi.number().min(0),
        currency: Joi.string(),
      }),
      inventory: Joi.object({
        quantity: Joi.number().integer().min(0),
        fulfillmentChannel: Joi.string(),
      }),
      status: Joi.string().valid('Active', 'Inactive', 'Incomplete', 'Closed', 'Out of Stock'),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const patch = {};
    if (value.title !== undefined) patch.title = value.title;
    if (value.status !== undefined) patch.status = value.status;
    if (value.price) {
      if (value.price.amount !== undefined) patch['price.amount'] = value.price.amount;
      if (value.price.currency !== undefined) patch['price.currency'] = value.price.currency;
    }
    if (value.inventory) {
      if (value.inventory.quantity !== undefined) {
        patch['inventory.quantity'] = value.inventory.quantity;
        patch['inventory.fulfillableQuantity'] = value.inventory.quantity;
        patch.inventoryManualOverrideAt = new Date();
      }
      if (value.inventory.fulfillmentChannel !== undefined) {
        patch['inventory.fulfillmentChannel'] = value.inventory.fulfillmentChannel;
      }
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const ifMatchMs = parseIfMatchHeader(req);
    const baseFilter = { _id: req.params.id, sellerId: req.user._id };
    const filter = applyIfMatchFilter(baseFilter, ifMatchMs);

    const product = await Product.findOneAndUpdate(
      filter,
      { $set: patch },
      { new: true, runValidators: true }
    );

    if (!product) {
      const exists = await Product.exists(baseFilter);
      if (exists && ifMatchMs != null) {
        return res.status(409).json({
          success: false,
          error: 'Product was modified by another request. Refresh and retry.',
        });
      }
      return res.status(404).json({
        success: false,
        error: 'Product not found',
      });
    }

    readResponseCache.invalidateSeller(PRODUCT_LIST_CACHE_NS, req.user._id);

    const etag = buildEntityTag(product.updatedAt);
    if (etag) res.set('ETag', etag);

    res.status(200).json({
      success: true,
      data: product,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete product
// @route   DELETE /api/products/:id
// @access  Private
const deleteProduct = async (req, res, next) => {
  try {
    const ifMatchMs = parseIfMatchHeader(req);
    const baseFilter = { _id: req.params.id, sellerId: req.user._id };
    const filter = applyIfMatchFilter(baseFilter, ifMatchMs);

    const product = await Product.findOneAndDelete(filter);

    if (!product) {
      const exists = await Product.exists(baseFilter);
      if (exists && ifMatchMs != null) {
        return res.status(409).json({
          success: false,
          error: 'Product was modified by another request. Refresh and retry.',
        });
      }
      return res.status(404).json({
        success: false,
        error: 'Product not found',
      });
    }

    readResponseCache.invalidateSeller(PRODUCT_LIST_CACHE_NS, req.user._id);

    res.status(200).json({
      success: true,
      data: {},
    });
  } catch (error) {
    next(error);
  }
};

// @route   POST /api/products/reconcile-listings
// @desc    Restore live SKUs falsely marked removed, then verify DB vs Seller Central
const reconcileListings = async (req, res, next) => {
  try {
    const restored = await restoreLiveListingsMarkedRemoved(req.user);
    const result = await reconcileSellerListings(req.user);
    readResponseCache.invalidateSeller(PRODUCT_LIST_CACHE_NS, req.user._id);
    res.status(200).json({
      success: true,
      message:
        restored.restored > 0 || result.removed > 0
          ? `Restored ${restored.restored || 0} live listing(s); removed ${result.removed || 0} deleted listing(s).`
          : 'All listings match Seller Central.',
      data: { restored, reconcile: result },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getProducts,
  getProduct,
  exportProducts,
  syncProducts,
  getInventorySyncStatus,
  stopInventorySync,
  updateProduct,
  deleteProduct,
  reconcileListings,
};
