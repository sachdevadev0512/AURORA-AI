const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const {
  applyOrderStatusFilter,
  applyFulfillmentChannelFilter,
  applySalesChannelFilter,
  applyOrderTypeFilter,
  applyOrderListDateRange,
  isReturnedStatusFilter,
} = require('../utils/orderStatusFilters');
const { enrichOrdersWithProductImages } = require('../utils/orderImageEnrichment');
const { applyListingFilter } = require('../utils/productListingUtils');
const { buildCaseInsensitiveRegex, buildMongoRegexFilter } = require('../utils/regexSearch');
const { CANONICAL_ORDER_STATUSES, normalizeOrderStatus, CANCELLED_STATUS_VARIANTS } = require('../utils/normalizeOrderStatus');
const {
  resolveDashboardTimeZone,
  resolveOrderTimeZone,
  zonedTimeToUtc,
  getDatePartsInTimeZone,
} = require('../utils/dashboardMetrics');
const Joi = require('joi');
const { parseExportLimit, exportLimitExceeded } = require('../utils/exportLimits');
const { reportItemQuantity } = require('../utils/orderReportUtils');
const { sleep, mapWithConcurrency } = require('../utils/async');
const { scheduleCustomerReturnsSync } = require('../services/customerReturnsService');
const { scheduleCustomerRefundsSync } = require('../services/customerRefundsService');

/**
 * The timezone Amazon Seller Central uses to display this seller's orders.
 * Resolved from the seller's marketplace so day boundaries and displayed
 * times match Seller Central exactly (instead of the server/browser TZ).
 */
function resolveSellerTimeZone(user = {}, query = {}) {
  return resolveDashboardTimeZone(user, query);
}

/** Attach the Seller-Central display timezone to each order for the frontend. */
function attachDisplayTimeZone(orders, fallbackTimeZone) {
  return orders.map((order) => {
    const plain = order && typeof order.toObject === 'function' ? order.toObject() : order;
    return { ...plain, displayTimeZone: resolveOrderTimeZone(plain, fallbackTimeZone) };
  });
}

async function buildAmazonApiForUser(user) {
  if (!user?.amazonRefreshToken) return null;
  const sellerAppCredentials = await getSellerAppCredentials(user._id);
  return new AmazonAPI(user, sellerAppCredentials);
}

const ORDER_REVENUE_ADD_FIELDS = {
  $addFields: {
    resolvedRevenue: {
      $let: {
        vars: {
          orderTotal: { $ifNull: ['$orderTotal.amount', 0] },
          itemsTotal: {
            $reduce: {
              input: { $ifNull: ['$orderItems', []] },
              initialValue: 0,
              in: {
                $add: [
                  '$$value',
                  {
                    $multiply: [
                      { $ifNull: ['$$this.itemPrice.amount', 0] },
                      { $max: [{ $ifNull: ['$$this.quantityOrdered', 1] }, 1] },
                    ],
                  },
                ],
              },
            },
          },
        },
        in: {
          $cond: [{ $gt: ['$$orderTotal', 0] }, '$$orderTotal', '$$itemsTotal'],
        },
      },
    },
  },
};

function summarizeOrdersPipeline(match) {
  return [
    { $match: match },
    ORDER_REVENUE_ADD_FIELDS,
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: '$resolvedRevenue' },
        totalItems: { $sum: { $ifNull: ['$numberOfItemsShipped', 0] } },
      },
    },
  ];
}

function withAverageOrderValue(summary) {
  const base = summary || { totalOrders: 0, totalRevenue: 0, totalItems: 0 };
  return {
    ...base,
    averageOrderValue:
      base.totalOrders > 0 ? base.totalRevenue / base.totalOrders : 0,
  };
}

const DASHBOARD_STATUS_BUCKET_FIELD = {
  $addFields: {
    dashboardStatus: {
      $switch: {
        branches: [
          {
            case: { $in: ['$orderStatus', ['Canceled', 'Cancelled', 'Unfulfillable']] },
            then: 'Cancelled',
          },
          {
            case: { $in: ['$orderStatus', ['Pending', 'InvoiceUnconfirmed']] },
            then: 'Pending',
          },
          { case: { $eq: ['$orderStatus', 'Unshipped'] }, then: 'Unshipped' },
          {
            case: {
              $and: [
                { $in: ['$orderStatus', ['Shipped', 'Shipping']] },
                { $gt: [{ $ifNull: ['$numberOfItemsUnshipped', 0] }, 0] },
              ],
            },
            then: 'Shipped',
          },
          {
            case: {
              $and: [
                { $in: ['$orderStatus', ['Shipped', 'Shipping']] },
                { $lte: [{ $ifNull: ['$numberOfItemsUnshipped', 0] }, 0] },
              ],
            },
            then: 'Delivered',
          },
          { case: { $eq: ['$orderStatus', 'PartiallyShipped'] }, then: 'Shipped' },
          {
            case: {
              $eq: [
                {
                  $convert: {
                    input: '$isReplacementOrder',
                    to: 'bool',
                    onError: false,
                    onNull: false,
                  },
                },
                true,
              ],
            },
            then: 'Returned',
          },
          {
            case: {
              $gt: [
                {
                  $strLenCP: {
                    $trim: {
                      input: {
                        $convert: {
                          input: '$replacedOrderId',
                          to: 'string',
                          onError: '',
                          onNull: '',
                        },
                      },
                    },
                  },
                },
                0,
              ],
            },
            then: 'Returned',
          },
          {
            case: {
              $gt: [
                {
                  $size: {
                    $filter: {
                      input: { $ifNull: ['$orderItems', []] },
                      as: 'item',
                      cond: {
                        $regexMatch: {
                          input: {
                            $toLower: {
                              $convert: {
                                input: '$$item.itemStatus',
                                to: 'string',
                                onError: '',
                                onNull: '',
                              },
                            },
                          },
                          regex: 'return',
                        },
                      },
                    },
                  },
                },
                0,
              ],
            },
            then: 'Returned',
          },
        ],
        default: 'Other',
      },
    },
  },
};

async function aggregateDashboardStatusBuckets(match) {
  return Order.aggregate([
    { $match: match },
    DASHBOARD_STATUS_BUCKET_FIELD,
    {
      $group: {
        _id: '$dashboardStatus',
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
  ]);
}

async function countListedProducts(sellerId, status) {
  const clauses = [{ sellerId }];
  applyListingFilter(clauses, 'listed');
  if (status) clauses.push({ status });
  const query = clauses.length === 1 ? { sellerId } : { $and: clauses };
  return Product.countDocuments(query);
}

function normalizeMoney(money, fallbackCurrency = 'USD') {
  if (!money) {
    return {
      amount: 0,
      currencyCode: fallbackCurrency,
    };
  }

  return {
    amount: Number(money.amount ?? money.Amount ?? 0), 
    currencyCode: money.currencyCode ?? money.CurrencyCode ?? fallbackCurrency,
  };
}

function normalizeDate(value) {
  return value ? new Date(value) : null;
}

function parseYmdParts(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return { year, month, day };
}

/**
 * Build a purchaseDate range from `YYYY-MM-DD` inputs using `timeZone`.
 * For Orders custom From/To, the client passes the browser IANA zone so the
 * window matches Seller Central Manage Orders custom range (which follows the
 * viewer's local calendar, while order timestamps still display in marketplace
 * PDT/PST). Last-N presets keep using the marketplace zone separately.
 */
function parseDateRangeForQuery(startDateRaw, endDateRaw, timeZone = 'UTC') {
  const range = {};
  const tz = timeZone || 'UTC';

  const startParts = parseYmdParts(startDateRaw);
  if (startParts) {
    range.$gte = zonedTimeToUtc(
      { ...startParts, hour: 0, minute: 0, second: 0, ms: 0 },
      tz,
    );
  }

  const endParts = parseYmdParts(endDateRaw);
  if (endParts) {
    range.$lte = zonedTimeToUtc(
      { ...endParts, hour: 23, minute: 59, second: 59, ms: 999 },
      tz,
    );
  }

  return Object.keys(range).length > 0 ? range : null;
}

/**
 * Resolve purchaseDate filter from explicit YYYY-MM-DD range or a day preset
 * (1, 3, 7, 14, 30, 90, 180, 365).
 *
 * Seller Central Manage Orders "Last N days" = marketplace-local calendar
 * from start of (today − N) through now. Empirically matches SC "Last day"
 * (e.g. PDT yesterday 00:00 → now), NOT a rolling N×24h window and NOT
 * "calendar today only".
 *
 * Custom startDate/endDate use the timezone supplied by the client (browser
 * local for Manage Orders parity). Marketplace midnight still applies when
 * that timezone is America/Los_Angeles.
 */
function resolveOrderPurchaseDateRange(query = {}, timeZone = 'UTC') {
  const tz = timeZone || 'UTC';

  if (query.startDate && query.endDate) {
    return parseDateRangeForQuery(query.startDate, query.endDate, tz);
  }

  const parsedDays = parseInt(query.days, 10);
  if (Number.isFinite(parsedDays) && parsedDays >= 1) {
    const days = Math.min(parsedDays, 366);
    const now = new Date();
    const todayParts = getDatePartsInTimeZone(now, tz);
    // SC "Last N days" starts at marketplace midnight N calendar days ago
    // (Last day ⇒ yesterday 00:00 PDT when "today" is already the next PDT day).
    const startParts = addUtcCalendarDays(todayParts, -days);
    return {
      $gte: utcDayStart(startParts, tz),
      $lte: now,
    };
  }

  return null;
}

function normalizeAddress(address) {
  if (!address) {
    return null;
  }

  return {
    name: address.name ?? address.Name ?? '',
    addressLine1: address.addressLine1 ?? address.AddressLine1 ?? '',
    addressLine2: address.addressLine2 ?? address.AddressLine2 ?? '',
    addressLine3: address.addressLine3 ?? address.AddressLine3 ?? '',
    city: address.city ?? address.City ?? '',
    county: address.county ?? address.County ?? '',
    district: address.district ?? address.District ?? '',
    stateOrRegion: address.stateOrRegion ?? address.StateOrRegion ?? '',
    municipality: address.municipality ?? address.Municipality ?? '',
    postalCode: address.postalCode ?? address.PostalCode ?? '',
    countryCode: address.countryCode ?? address.CountryCode ?? '',
    phone: address.phone ?? address.Phone ?? '',
    addressType: address.addressType ?? address.AddressType ?? '',
  };
}

function normalizePromotionIds(promotionIds) {
  if (!promotionIds) {
    return [];
  }

  if (Array.isArray(promotionIds)) {
    return promotionIds.filter(Boolean);
  }

  return String(promotionIds)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function extractCatalogImage(catalogItem) {
  const imageSets = catalogItem?.images || [];

  for (const imageSet of imageSets) {
    if (Array.isArray(imageSet?.images) && imageSet.images.length > 0) {
      const firstImage = imageSet.images[0];
      if (firstImage?.link) {
        return firstImage.link;
      }
    }
  }

  return null;
}

function flattenOrdersForReport(orders) {
  return orders.flatMap((order) => {
    const orderItems = order.orderItems?.length ? order.orderItems : [{}];

    return orderItems.map((item) => ({
      amazonOrderId: order.amazonOrderId,
      sellerOrderId: order.sellerOrderId || '',
      purchaseDate: order.purchaseDate ? new Date(order.purchaseDate).toISOString() : '',
      lastUpdateDate: order.lastUpdateDate ? new Date(order.lastUpdateDate).toISOString() : '',
      orderStatus: order.orderStatus || '',
      fulfillmentChannel: order.fulfillmentChannel || '',
      salesChannel: order.salesChannel || '',
      shipServiceLevel: [order.shipServiceLevel, order.shipmentServiceLevelCategory].filter(Boolean).join(' / '),
      productName: item.title || '',
      sku: item.sellerSku || '',
      asin: item.asin || '',
      itemStatus: item.itemStatus || order.orderStatus || '',
      quantity: reportItemQuantity(order, item),
      currency: item.itemPrice?.currencyCode || order.orderTotal?.currencyCode || '',
      itemPrice: item.itemPrice?.amount || 0,
      shippingCity: order.shippingAddress?.city || '',
      shippingState: order.shippingAddress?.stateOrRegion || '',
      shippingPostalCode: order.shippingAddress?.postalCode || '',
      shippingCountry: order.shippingAddress?.countryCode || '',
      promotionIds: (item.promotionIds || []).join('; '),
      isBusinessOrder: order.isBusinessOrder ? 'Yes' : 'No',
      buyerEmail: order.buyerEmail || '',
      buyerName: order.buyerName || '',
      marketplaceId: order.marketplaceId || '',
      paymentMethod: order.paymentMethod || '',
      isReplacementOrder: order.isReplacementOrder ? 'Yes' : 'No',
    }));
  });
}

function* iterFlattenOrdersForReport(orders) {
  for (const order of orders) {
    const orderItems = order.orderItems?.length ? order.orderItems : [{}];
    for (const item of orderItems) {
      yield {
        amazonOrderId: order.amazonOrderId,
        sellerOrderId: order.sellerOrderId || '',
        purchaseDate: order.purchaseDate ? new Date(order.purchaseDate).toISOString() : '',
        lastUpdateDate: order.lastUpdateDate ? new Date(order.lastUpdateDate).toISOString() : '',
        orderStatus: order.orderStatus || '',
        fulfillmentChannel: order.fulfillmentChannel || '',
        salesChannel: order.salesChannel || '',
        shipServiceLevel: [order.shipServiceLevel, order.shipmentServiceLevelCategory].filter(Boolean).join(' / '),
        productName: item.title || '',
        sku: item.sellerSku || '',
        asin: item.asin || '',
        itemStatus: item.itemStatus || order.orderStatus || '',
        quantity: reportItemQuantity(order, item),
        currency: item.itemPrice?.currencyCode || order.orderTotal?.currencyCode || '',
        itemPrice: item.itemPrice?.amount || 0,
        shippingCity: order.shippingAddress?.city || '',
        shippingState: order.shippingAddress?.stateOrRegion || '',
        shippingPostalCode: order.shippingAddress?.postalCode || '',
        shippingCountry: order.shippingAddress?.countryCode || '',
        promotionIds: (item.promotionIds || []).join('; '),
        isBusinessOrder: order.isBusinessOrder ? 'Yes' : 'No',
        buyerEmail: order.buyerEmail || '',
        buyerName: order.buyerName || '',
        marketplaceId: order.marketplaceId || '',
        paymentMethod: order.paymentMethod || '',
        isReplacementOrder: order.isReplacementOrder ? 'Yes' : 'No',
      };
    }
  }
}

// Helper function to get marketplace name from ID
function getMarketplaceName(marketplaceId) {
  const marketplaces = {
    'ATVPDKIKX0DER': 'Amazon.com',
    'A2EUQ1WTGCTBG2': 'Amazon.ca',
    'A1AM78C64UM0Y8': 'Amazon.mx',
    'A2Q3Y263D00KWC': 'Amazon.br',
    'A1PA6795UKMFR9': 'Amazon.de',
    'A1RKKUPIHCS9HS': 'Amazon.es',
    'A13V1IB3VIYZZH': 'Amazon.fr',
    'A21TJRUUN4KGV': 'Amazon.in',
    'APJ6JRA9NG5V4': 'Amazon.it',
    'A1F83G8C2ARO7P': 'Amazon.co.uk',
    'A1VC38T7YXB528': 'Amazon.co.jp',
    'AAHKV2X7AFYLW': 'Amazon.cn',
    'A39IBJ37TRP1C6': 'Amazon.au',
  };

  return marketplaces[marketplaceId] || 'Unknown Marketplace';
}

// @desc    Get all orders for a user
// @route   GET /api/orders
// @access  Private
const getOrders = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 25;
    const startIndex = (page - 1) * limit;
    const sortBy = req.query.sortBy || 'purchaseDate';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

    // Build query
    let query = { sellerId: req.user._id };

    // Global search across order and item fields
    if (req.query.search) {
      const search = String(req.query.search).trim();
      const searchRegex = buildCaseInsensitiveRegex(search);
      if (searchRegex) {
        query.$or = [
          { amazonOrderId: searchRegex },
          { sellerOrderId: searchRegex },
          { buyerName: searchRegex },
          { buyerEmail: searchRegex },
          { 'orderItems.sellerSku': searchRegex },
          { 'orderItems.asin': searchRegex },
          { 'orderItems.title': searchRegex },
        ];
      }
    }

    // Filter by status (supports Aurora filter keys: pending, unshipped, shipped, etc.)
    // Seller Central FBA "All orders" excludes Canceled (those live under the
    // Canceled tab) — match that when no status filter is selected.
    if (req.query.status) {
      query = applyOrderStatusFilter(query, req.query.status);
    } else {
      query.orderStatus = {
        $nin: CANCELLED_STATUS_VARIANTS.concat(['Unfulfillable']),
      };
    }

    const amazonAPI = await buildAmazonApiForUser(req.user);

    // Filter by fulfillment channel
    if (req.query.fulfillmentChannel) {
      query = applyFulfillmentChannelFilter(query, req.query.fulfillmentChannel);
    }

    // Seller Central "Refine by" advanced filters
    if (req.query.salesChannel) {
      query = applySalesChannelFilter(query, req.query.salesChannel);
    }
    if (req.query.orderType) {
      query = applyOrderTypeFilter(query, req.query.orderType);
    }

    // Filter by date range using the marketplace timezone (matches Seller Central).
    // Exact Amazon order-id search should not be constrained by the date preset
    // (Seller Central search finds the order even outside the selected range).
    const timeZone = resolveSellerTimeZone(req.user, req.query);
    const purchaseDateRange = resolveOrderPurchaseDateRange(req.query, timeZone);
    const searchText = String(req.query.search || '').trim();
    const skipDateForOrderIdSearch = /^\d{3}-\d{7}-\d{7}$/.test(searchText);
    if (!skipDateForOrderIdSearch) {
      query = applyOrderListDateRange(query, purchaseDateRange, req.query.status);
    }

    // Returned tab: refresh FBA customer returns + Finances refunds in the
    // background (each cooldown-gated). Refunds cover returnless refunds the
    // FBA returns report never lists.
    if (isReturnedStatusFilter(req.query.status)) {
      scheduleCustomerReturnsSync(req.user, amazonAPI).catch(() => {});
      scheduleCustomerRefundsSync(req.user, amazonAPI).catch(() => {});
    }

    const allowedSortFields = [
      'purchaseDate',
      'latestCustomerReturnDate',
      'latestRefundDate',
      'latestReturnedActivityDate',
      'promiseResponseDueDate',
      'shipServiceLevel',
      'lastUpdateDate',
      'orderStatus',
      'amazonOrderId',
      'orderTotal.amount',
    ];
    // Returned tab defaults to the unified return/refund activity date so recent
    // FBA returns AND returnless refunds both surface on page 1. Sorting only by
    // latestCustomerReturnDate buried refund-only orders (null return date).
    let sortField = allowedSortFields.includes(sortBy) ? sortBy : 'purchaseDate';
    let effectiveSortOrder = sortOrder;
    if (isReturnedStatusFilter(req.query.status)) {
      if (!req.query.sortBy || sortBy === 'purchaseDate') {
        sortField = 'latestReturnedActivityDate';
        effectiveSortOrder = -1;
      } else if (sortBy === 'latestCustomerReturnDate') {
        // UI still labels this "Return date" — map to the unified field so
        // refund-only rows aren't buried by a null FBA return date.
        sortField = 'latestReturnedActivityDate';
      }
    }

    const orders = await Order.find(query)
      .sort({ [sortField]: effectiveSortOrder })
      .limit(limit)
      .skip(startIndex)
      .populate('sellerId', 'name email');

    const total = await Order.countDocuments(query);
    const enrichedOrders = await enrichOrdersWithProductImages(orders, req.user._id, { amazonAPI });
    const data = attachDisplayTimeZone(enrichedOrders, timeZone);

    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      success: true,
      count: data.length,
      timeZone,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      data,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single order
// @route   GET /api/orders/:id
// @access  Private
const getOrder = async (req, res, next) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      sellerId: req.user._id,
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    const amazonAPI = await buildAmazonApiForUser(req.user);
    const [enrichedOrder] = await enrichOrdersWithProductImages([order], req.user._id, { amazonAPI });
    const timeZone = resolveSellerTimeZone(req.user, req.query);
    const [data] = attachDisplayTimeZone([enrichedOrder], timeZone);

    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      success: true,
      timeZone,
      data,
    });
  } catch (error) {
    next(error);
  }
};

async function ensureOrderSyncMarketplaceContext(user, sellerAppCredentials) {
  if (Array.isArray(user.amazonMarketplaceIds) && user.amazonMarketplaceIds.length > 0) {
    return user;
  }

  const regions = [...new Set([user.marketplace, 'NA', 'EU', 'FE'].filter(Boolean))];

  for (const region of regions) {
    try {
      const amazonAPI = new AmazonAPI(
        {
          amazonRefreshToken: user.amazonRefreshToken,
          marketplace: region,
        },
        sellerAppCredentials
      );

      const response = await amazonAPI.callSpApi({
        operation: 'getMarketplaceParticipations',
        endpoint: 'sellers',
      });

      const participations = response?.payload || response?.marketplaceParticipations || response || [];
      const marketplaceIds = Array.isArray(participations)
        ? participations
          .map((participation) => (
            participation?.marketplace?.id ||
            participation?.Marketplace?.Id ||
            participation?.marketplaceId
          ))
          .filter(Boolean)
        : [];

      if (marketplaceIds.length > 0) {
        const { sortMarketplaceIds } = require('../utils/marketplacePriority');
        const sortedIds = sortMarketplaceIds(marketplaceIds, region);
        await User.findByIdAndUpdate(user._id, {
          marketplace: region,
          amazonMarketplaceIds: sortedIds,
        });

        return {
          ...user.toObject(),
          marketplace: region,
          amazonMarketplaceIds: sortedIds,
        };
      }
    } catch (error) {
      console.warn('[syncOrders] Marketplace discovery failed:', {
        region,
        message: error.message,
      });
    }
  }

  return user;
}

const syncOrders = async (req, res, next) => {
  try {
    const { orderSyncManager } = require('../services/orderSyncService');
    const result = await orderSyncManager.start(req.user._id, {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    res.status(202).json(result);
  } catch (error) {
    if (error.code === 'SP_NOT_CONNECTED') {
      return res.status(400).json({ success: false, error: error.message });
    }
    next(error);
  }
};

const getOrderSyncStatus = async (req, res, next) => {
  try {
    const { orderSyncManager } = require('../services/orderSyncService');
    const status = await orderSyncManager.getStatus(req.user._id);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.status(200).json({ success: true, ...status });
  } catch (error) {
    next(error);
  }
};

const stopOrderSync = async (req, res, next) => {
  try {
    const { orderSyncManager } = require('../services/orderSyncService');
    const result = await orderSyncManager.stop(req.user._id);
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
};

// @desc    Get order statistics
// @route   GET /api/orders/stats
// @access  Private
const getOrderStats = async (req, res, next) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const stats = await Order.aggregate([
      {
        $match: {
          sellerId: req.user._id,
          purchaseDate: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalRevenue: { $sum: '$orderTotal.amount' },
          averageOrderValue: { $avg: '$orderTotal.amount' },
          ordersByStatus: {
            $push: '$orderStatus',
          },
        },
      },
    ]);

    // Count orders by status
    const statusCounts = {};
    if (stats.length > 0) {
      stats[0].ordersByStatus.forEach(status => {
        statusCounts[status] = (statusCounts[status] || 0) + 1;
      });
      stats[0].ordersByStatus = statusCounts;
    }

    res.status(200).json({
      success: true,
      data: stats[0] || {
        totalOrders: 0,
        totalRevenue: 0,
        averageOrderValue: 0,
        ordersByStatus: {},
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get orders with dashboard-specific filtering
// @route   GET /api/orders/dashboard
// @access  Private
const getDashboardOrders = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 25;
    const startIndex = (page - 1) * limit;

    // Build query with dashboard filters
    let query = { sellerId: req.user._id };

    // Status filter (pending, unshipped, shipped, delivered, cancelled, returned)
    // Match Seller Central "All orders" — exclude canceled unless Cancelled tab.
    if (req.query.status) {
      query = applyOrderStatusFilter(query, req.query.status);
    } else {
      query.orderStatus = {
        $nin: CANCELLED_STATUS_VARIANTS.concat(['Unfulfillable']),
      };
    }

    // Fulfillment channel filter
    if (req.query.fulfillmentChannel) {
      query = applyFulfillmentChannelFilter(query, req.query.fulfillmentChannel);
    }

    if (req.query.salesChannel) {
      query = applySalesChannelFilter(query, req.query.salesChannel);
    }
    if (req.query.orderType) {
      query = applyOrderTypeFilter(query, req.query.orderType);
    }

    // Date range filter using the marketplace timezone (matches Seller Central)
    const timeZone = resolveSellerTimeZone(req.user, req.query);
    const purchaseDateRange = resolveOrderPurchaseDateRange(req.query, timeZone);
    query = applyOrderListDateRange(query, purchaseDateRange, req.query.status);

    // Search by Amazon Order ID
    if (req.query.amazonOrderId) {
      const amazonOrderIdFilter = buildMongoRegexFilter(req.query.amazonOrderId);
      if (amazonOrderIdFilter) {
        query.amazonOrderId = amazonOrderIdFilter;
      }
    }

    // Search by Buyer Name
    if (req.query.buyerName) {
      const buyerNameFilter = buildMongoRegexFilter(req.query.buyerName);
      if (buyerNameFilter) {
        query.buyerName = buyerNameFilter;
      }
    }

    const orders = await Order.find(query)
      .sort({ purchaseDate: -1 })
      .limit(limit)
      .skip(startIndex)
      .populate('sellerId', 'name email')
      .select({
        amazonOrderId: 1,
        sellerOrderId: 1,
        purchaseDate: 1,
        orderStatus: 1,
        fulfillmentChannel: 1,
        salesChannel: 1,
        orderTotal: 1,
        buyerName: 1,
        buyerEmail: 1,
        shippingAddress: 1,
        'orderItems.title': 1,
        'orderItems.sellerSku': 1,
        'orderItems.asin': 1,
        'orderItems.fnsku': 1,
        'orderItems.quantityOrdered': 1,
        'orderItems.itemPrice': 1,
        'orderItems.productImage': 1,
        'orderItems.referralFee': 1,
        'orderItems.fulfillmentFee': 1,
        'orderItems.costOfGoodsSold': 1,
        'orderItems.itemSubtotal': 1,
        lastSynced: 1,
      });

    const total = await Order.countDocuments(query);
    const data = attachDisplayTimeZone(orders, timeZone);

    res.status(200).json({
      success: true,
      count: data.length,
      timeZone,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      data,
    });
  } catch (error) {
    next(error);
  }
};

function parseDateOnlyInput(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  return { year, month, day };
}

function utcDayStart(parts, timeZone = 'UTC') {
  return zonedTimeToUtc({ ...parts, hour: 0, minute: 0, second: 0, ms: 0 }, timeZone);
}

function utcDayEnd(parts, timeZone = 'UTC') {
  return zonedTimeToUtc({ ...parts, hour: 23, minute: 59, second: 59, ms: 999 }, timeZone);
}

function addUtcCalendarDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + days);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function formatDateOnlyUtc(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateOnlyKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function inclusiveUtcDayCount(startDate, endDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(1, Math.floor((endDate.getTime() - startDate.getTime()) / msPerDay) + 1);
}

function analyticsDateString(timeZone = 'UTC', format = '%Y-%m-%d') {
  return {
    $dateToString: { format, date: '$purchaseDate', timezone: timeZone || 'UTC' },
  };
}

function resolveAnalyticsDateRange(query = {}, timeZone = 'UTC') {
  const tz = timeZone || 'UTC';
  if (query.startDate && query.endDate) {
    const startParts = parseDateOnlyInput(query.startDate);
    const endParts = parseDateOnlyInput(query.endDate);

    if (startParts && endParts) {
      const startDate = utcDayStart(startParts, tz);
      const endDate = utcDayEnd(endParts, tz);
      if (startDate <= endDate) {
        return {
          startDate,
          endDate,
          days: inclusiveUtcDayCount(startDate, endDate),
          preset: 'custom',
          startParts,
          endParts,
          startDateKey: formatDateOnlyKey(startParts),
          endDateKey: formatDateOnlyKey(endParts),
        };
      }
    }
  }

  const parsedDays = parseInt(query.days, 10);
  const days = Number.isFinite(parsedDays) ? Math.min(Math.max(parsedDays, 1), 366) : 30;
  const todayParts = getDatePartsInTimeZone(new Date(), tz);
  const endDate = utcDayEnd(todayParts, tz);
  const startPartsFromPreset = addUtcCalendarDays(todayParts, -(days - 1));
  const startDate = utcDayStart(startPartsFromPreset, tz);

  return {
    startDate,
    endDate,
    days,
    preset: String(days),
    startParts: startPartsFromPreset,
    endParts: todayParts,
    startDateKey: formatDateOnlyKey(startPartsFromPreset),
    endDateKey: formatDateOnlyKey(todayParts),
  };
}

function chartDateFormatForPeriod(days) {
  return days <= 90 ? '%Y-%m-%d' : '%Y-%m';
}

function buildPreviousPeriodRange(startParts, days, timeZone = 'UTC') {
  const prevEndParts = addUtcCalendarDays(startParts, -1);
  const prevStartParts = addUtcCalendarDays(startParts, -days);
  return {
    prevStart: utcDayStart(prevStartParts, timeZone),
    prevEnd: utcDayEnd(prevEndParts, timeZone),
  };
}

// @desc    Get order analytics for dashboard
// @route   GET /api/orders/analytics
// @access  Private
const getOrderAnalytics = async (req, res, next) => {
  try {
    const sellerId = req.user._id;
    const timeZone = resolveSellerTimeZone(req.user, req.query);
    const {
      startDate,
      endDate,
      days,
      preset,
      startParts,
      startDateKey,
      endDateKey,
    } = resolveAnalyticsDateRange(req.query, timeZone);

    const dateFilter = {
      sellerId,
      purchaseDate: { $gte: startDate, $lte: endDate },
    };

    const { prevStart, prevEnd } = buildPreviousPeriodRange(startParts, days, timeZone);
    const prevDateFilter = {
      sellerId,
      purchaseDate: { $gte: prevStart, $lte: prevEnd },
    };

    const chartFormat = chartDateFormatForPeriod(days);
    const chartDateString = analyticsDateString(timeZone, chartFormat);
    const dailyDateString = analyticsDateString(timeZone, '%Y-%m-%d');

    // Prevent "allTime" aggregations from scanning the full order history by default.
    const allTimeMaxDays = parseInt(process.env.ORDER_ANALYTICS_ALLTIME_MAX_DAYS || '365', 10);
    const allTimeMatch =
      Number.isFinite(allTimeMaxDays) && allTimeMaxDays > 0
        ? (() => {
          const start = new Date(Date.now() - allTimeMaxDays * 24 * 60 * 60 * 1000);
          start.setUTCHours(0, 0, 0, 0);
          return {
            sellerId,
            purchaseDate: { $gte: start, $lte: endDate },
          };
        })()
        : { sellerId };

    const orderFacetResults = await Order.aggregate([
      {
        $facet: {
          totalStats: summarizeOrdersPipeline(dateFilter),
          previousPeriodStats: summarizeOrdersPipeline(prevDateFilter),
          statusStats: [
            { $match: dateFilter },
            {
              $group: {
                _id: '$orderStatus',
                count: { $sum: 1 },
                revenue: { $sum: { $ifNull: ['$orderTotal.amount', 0] } },
              },
            },
            { $sort: { count: -1 } },
          ],
          channelStats: [
            { $match: dateFilter },
            {
              $group: {
                _id: '$fulfillmentChannel',
                count: { $sum: 1 },
                revenue: { $sum: { $ifNull: ['$orderTotal.amount', 0] } },
              },
            },
          ],
          topProducts: [
            { $match: dateFilter },
            { $unwind: '$orderItems' },
            {
              $group: {
                _id: {
                  asin: '$orderItems.asin',
                  title: '$orderItems.title',
                  sellerSku: '$orderItems.sellerSku',
                },
                totalSold: { $sum: '$orderItems.quantityOrdered' },
                totalRevenue: { $sum: '$orderItems.itemSubtotal.amount' },
                orders: { $sum: 1 },
              },
            },
            { $sort: { totalSold: -1 } },
            { $limit: 10 },
          ],
          dailySales: [
            { $match: dateFilter },
            {
              $group: {
                _id: dailyDateString,
                orders: { $sum: 1 },
                revenue: { $sum: { $ifNull: ['$orderTotal.amount', 0] } },
                items: { $sum: '$numberOfItemsShipped' },
              },
            },
            { $sort: { _id: 1 } },
          ],
          chartSales: [
            { $match: dateFilter },
            ORDER_REVENUE_ADD_FIELDS,
            {
              $group: {
                _id: chartDateString,
                revenue: { $sum: '$resolvedRevenue' },
                orders: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ],
          statusBuckets: [
            { $match: dateFilter },
            DASHBOARD_STATUS_BUCKET_FIELD,
            {
              $group: {
                _id: '$dashboardStatus',
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1 } },
          ],
          profitStats: [
            { $match: dateFilter },
            { $unwind: '$orderItems' },
            {
              $group: {
                _id: null,
                totalRevenue: { $sum: '$orderItems.itemSubtotal.amount' },
                totalReferralFees: { $sum: '$orderItems.referralFee.amount' },
                totalFulfillmentFees: { $sum: '$orderItems.fulfillmentFee.amount' },
                totalCOGS: { $sum: '$orderItems.costOfGoodsSold.amount' },
              },
            },
          ],
        },
      },
    ]);

    const facet = orderFacetResults?.[0] || {};
    const totalStats = facet.totalStats || [];
    const previousPeriodStats = facet.previousPeriodStats || [];
    const statusStats = facet.statusStats || [];
    const channelStats = facet.channelStats || [];
    const topProducts = facet.topProducts || [];
    const dailySales = facet.dailySales || [];
    const chartSales = facet.chartSales || [];
    const statusBuckets = facet.statusBuckets || [];
    const profitStats = facet.profitStats || [];

    const [activeProducts, listedProducts] = await Promise.all([
      countListedProducts(sellerId, 'Active'),
      countListedProducts(sellerId),
    ]);

    const allTimeStats = await Order.aggregate(summarizeOrdersPipeline(allTimeMatch));

    const summary = withAverageOrderValue(totalStats[0]);
    const allTimeSummary = withAverageOrderValue(allTimeStats[0]);
    const previousSummary = withAverageOrderValue(previousPeriodStats[0]);

    const analytics = {
      period: {
        startDate: startDateKey,
        endDate: endDateKey,
        days,
        preset,
        timeZone,
        chartGranularity: days <= 90 ? 'day' : 'month',
        allTimeWindowDays: allTimeMaxDays > 0 ? allTimeMaxDays : null,
      },
      summary,
      allTimeSummary,
      previousSummary,
      productCounts: {
        active: activeProducts,
        listed: listedProducts,
      },
      statusBuckets,
      statusBreakdown: statusStats,
      channelBreakdown: channelStats,
      topProducts,
      dailySales,
      chartSales,
      monthlySales: chartSales,
      profitMetrics: profitStats[0] || {
        totalRevenue: 0,
        totalReferralFees: 0,
        totalFulfillmentFees: 0,
        totalCOGS: 0,
      },
    };

    // Calculate derived metrics
    if (analytics.profitMetrics.totalRevenue > 0) {
      analytics.profitMetrics.netProfit = analytics.profitMetrics.totalRevenue -
        analytics.profitMetrics.totalReferralFees -
        analytics.profitMetrics.totalFulfillmentFees -
        analytics.profitMetrics.totalCOGS;
      analytics.profitMetrics.profitMargin = (analytics.profitMetrics.netProfit / analytics.profitMetrics.totalRevenue) * 100;
    }

    res.status(200).json({
      success: true,
      data: analytics,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Bulk update order status
// @route   POST /api/orders/bulk/status
// @access  Private
const bulkUpdateOrderStatus = async (req, res, next) => {
  try {
    const { orderIds, status } = req.body;

    if (!orderIds || !Array.isArray(orderIds) || !status) {
      return res.status(400).json({
        success: false,
        error: 'Order IDs array and status are required',
      });
    }

    const normalizedStatus = normalizeOrderStatus(status);
    if (!normalizedStatus || !CANONICAL_ORDER_STATUSES.includes(normalizedStatus)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status provided',
      });
    }

    const result = await Order.updateMany(
      { _id: { $in: orderIds }, sellerId: req.user._id },
      {
        orderStatus: normalizedStatus,
        lastUpdateDate: new Date(),
        updatedAt: new Date(),
      }
    );

    res.status(200).json({
      success: true,
      message: `Updated ${result.modifiedCount} orders to status: ${normalizedStatus}`,
      scope: 'local_database_only',
      data: {
        modifiedCount: result.modifiedCount,
        matchedCount: result.matchedCount,
        status: normalizedStatus,
      },
    });
  } catch (error) {
    next(error);
  }
};

function buildOrdersListQuery(user, params = {}) {
  let query = { sellerId: user._id };

  if (params.search) {
    const search = String(params.search).trim();
    const searchRegex = buildCaseInsensitiveRegex(search);
    if (searchRegex) {
      query.$or = [
        { amazonOrderId: searchRegex },
        { sellerOrderId: searchRegex },
        { buyerName: searchRegex },
        { buyerEmail: searchRegex },
        { 'orderItems.sellerSku': searchRegex },
        { 'orderItems.asin': searchRegex },
        { 'orderItems.title': searchRegex },
      ];
    }
  }

  if (params.status) {
    query = applyOrderStatusFilter(query, params.status);
  } else {
    // Seller Central "All orders" excludes canceled (Canceled tab is separate).
    query.orderStatus = {
      $nin: CANCELLED_STATUS_VARIANTS.concat(['Unfulfillable']),
    };
  }

  if (params.fulfillmentChannel) {
    query = applyFulfillmentChannelFilter(query, params.fulfillmentChannel);
  }

  if (params.salesChannel) {
    query = applySalesChannelFilter(query, params.salesChannel);
  }
  if (params.orderType) {
    query = applyOrderTypeFilter(query, params.orderType);
  }

  const timeZone = resolveSellerTimeZone(user, params);
  const purchaseDateRange = resolveOrderPurchaseDateRange(params, timeZone);
  const searchText = String(params.search || '').trim();
  const skipDateForOrderIdSearch = /^\d{3}-\d{7}-\d{7}$/.test(searchText);
  if (!skipDateForOrderIdSearch) {
    query = applyOrderListDateRange(query, purchaseDateRange, params.status);
  }

  return { query, timeZone };
}

const ORDER_CSV_HEADERS = [
  'Amazon Order ID',
  'Seller Order ID',
  'Purchase Date & Time',
  'Last Update Date',
  'Order Status',
  'Fulfillment Channel',
  'Sales Channel',
  'Ship Service Level / Shipment Service Level Category',
  'product-name',
  'sku',
  'asin',
  'item-status',
  'quantity',
  'Currency',
  'item-price',
  'Shipping City',
  'Shipping State',
  'Shipping Postal Code',
  'Shipping Country',
  'promotion-ids',
  'Is Business Order',
  'Buyer Name',
  'Buyer Email',
  'Marketplace ID',
  'Payment Method',
  'Is Replacement Order',
];

async function streamOrdersCsvToResponse(res, query, sortField, sortOrder) {
  const MAX_EXPORT_ROWS = parseExportLimit(process.env.ORDER_EXPORT_MAX_ROWS, 0);
  const escapeCsvCell = (value) => String(value ?? '').replace(/"/g, '""');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename=orders-export-${Date.now()}.csv`,
  );
  res.status(200);
  res.write(`${ORDER_CSV_HEADERS.map((h) => `"${escapeCsvCell(h)}"`).join(',')}\n`);

  const cursor = Order.find(query).sort({ [sortField]: sortOrder }).cursor();
  let writtenRows = 0;

  for await (const order of cursor) {
    for (const row of iterFlattenOrdersForReport([order])) {
      writtenRows += 1;
      if (exportLimitExceeded(writtenRows, MAX_EXPORT_ROWS)) {
        await cursor.close().catch(() => {});
        res.end();
        return;
      }

      const values = [
        row.amazonOrderId,
        row.sellerOrderId,
        row.purchaseDate,
        row.lastUpdateDate,
        row.orderStatus,
        row.fulfillmentChannel,
        row.salesChannel,
        row.shipServiceLevel,
        row.productName,
        row.sku,
        row.asin,
        row.itemStatus,
        row.quantity,
        row.currency,
        row.itemPrice,
        row.shippingCity,
        row.shippingState,
        row.shippingPostalCode,
        row.shippingCountry,
        row.promotionIds,
        row.isBusinessOrder,
        row.buyerName,
        row.buyerEmail,
        row.marketplaceId,
        row.paymentMethod,
        row.isReplacementOrder,
      ];

      res.write(`${values.map((v) => `"${escapeCsvCell(v)}"`).join(',')}\n`);
    }
  }

  res.end();
}

function resolveOrdersExportSort(queryParams = {}) {
  const allowedSortFields = [
    'purchaseDate',
    'promiseResponseDueDate',
    'shipServiceLevel',
    'lastUpdateDate',
    'orderStatus',
    'amazonOrderId',
    'orderTotal.amount',
  ];
  const sortField = allowedSortFields.includes(queryParams.sortBy)
    ? queryParams.sortBy
    : 'purchaseDate';
  const sortOrder = queryParams.sortOrder === 'asc' ? 1 : -1;
  return { sortField, sortOrder };
}

function buildOrdersExportQuery(user, params = {}) {
  if (params.orderIds) {
    const ids = String(params.orderIds)
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length > 0) {
      return { _id: { $in: ids }, sellerId: user._id };
    }
  }
  return buildOrdersListQuery(user, params).query;
}

// @desc    Download orders CSV (same filters as GET /orders — no orderIds required)
// @route   GET /api/orders/export/csv
// @access  Private
const exportOrdersCsv = async (req, res, next) => {
  try {
    const query = buildOrdersExportQuery(req.user, req.query);
    const { sortField, sortOrder } = resolveOrdersExportSort(req.query);
    await streamOrdersCsvToResponse(res, query, sortField, sortOrder);
  } catch (error) {
    next(error);
  }
};

// @desc    Bulk export orders (by IDs or by the same filters as the Orders list)
// @route   POST /api/orders/bulk/export
// @access  Private
const bulkExportOrders = async (req, res, next) => {
  try {
    const {
      orderIds,
      format = 'csv',
      status,
      fulfillmentChannel,
      salesChannel,
      orderType,
      startDate,
      endDate,
      search,
      sortBy: sortByRaw,
      sortOrder: sortOrderRaw,
    } = req.body || {};

    const hasIds = Array.isArray(orderIds) && orderIds.length > 0;
    // 0 / unset = unlimited. Only enforce when ORDER_EXPORT_MAX_* is a positive int.
    const MAX_ORDER_IDS = parseExportLimit(process.env.ORDER_EXPORT_MAX_ORDER_IDS, 0);

    if (hasIds && exportLimitExceeded(orderIds.length, MAX_ORDER_IDS)) {
      return res.status(400).json({
        success: false,
        error: `Too many orders to export. Max ${MAX_ORDER_IDS} order(s) per request.`,
      });
    }

    if (!hasIds && orderIds != null && !Array.isArray(orderIds)) {
      return res.status(400).json({
        success: false,
        error: 'Order IDs must be an array when provided',
      });
    }

    let query;
    if (hasIds) {
      query = { _id: { $in: orderIds }, sellerId: req.user._id };
    } else {
      ({ query } = buildOrdersListQuery(req.user, {
        status,
        fulfillmentChannel,
        salesChannel,
        orderType,
        startDate,
        endDate,
        search,
      }));
    }

    const { sortField, sortOrder } = resolveOrdersExportSort({
      sortBy: sortByRaw,
      sortOrder: sortOrderRaw,
    });

    if (format === 'csv') {
      await streamOrdersCsvToResponse(res, query, sortField, sortOrder);
      return;
    }

    const orders = await Order.find(query)
      .sort({ [sortField]: sortOrder })
      .populate('sellerId', 'name email');

    res.status(200).json({
      success: true,
      count: orders.length,
      data: orders,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update single order status
// @route   PUT /api/orders/:id/status
// @access  Private
const updateOrderStatus = async (req, res, next) => {
  try {
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        error: 'Status is required',
      });
    }

    const normalizedStatus = normalizeOrderStatus(status);
    if (!normalizedStatus || !CANONICAL_ORDER_STATUSES.includes(normalizedStatus)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status provided',
      });
    }

    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, sellerId: req.user._id },
      {
        orderStatus: normalizedStatus,
        lastUpdateDate: new Date(),
        updatedAt: new Date(),
      },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    res.status(200).json({
      success: true,
      message: `Order status updated to ${normalizedStatus}`,
      scope: 'local_database_only',
      data: order,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Add note to order
// @route   POST /api/orders/:id/notes
// @access  Private
const addOrderNote = async (req, res, next) => {
  try {
    const { note, noteType = 'general' } = req.body;

    if (!note || typeof note !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Note text is required',
      });
    }

    // For now, we'll store notes in a simple array
    // In production, you might want a separate Notes collection
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, sellerId: req.user._id },
      {
        $push: {
          notes: {
            text: note,
            type: noteType,
            createdBy: req.user._id,
            createdAt: new Date(),
          }
        },
        updatedAt: new Date(),
      },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Note added successfully',
      data: order.notes[order.notes.length - 1],
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getOrders,
  getOrder,
  syncOrders,
  getOrderSyncStatus,
  stopOrderSync,
  getOrderStats,
  getDashboardOrders,
  getOrderAnalytics,
  bulkUpdateOrderStatus,
  bulkExportOrders,
  exportOrdersCsv,
  updateOrderStatus,
  addOrderNote,
};
