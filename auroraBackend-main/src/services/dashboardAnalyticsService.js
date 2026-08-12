const Order = require('../models/Order');
const Product = require('../models/Product');
const Ad = require('../models/Ad');
const { applyListingFilter } = require('../utils/productListingUtils');
const {
  CANCELLED_ORDER_STATUSES,
  resolveDashboardTimeZone,
  buildPresetPeriods,
  startOfDayInTimeZone,
  endOfDayInTimeZone,
  ORDER_METRICS_FIELDS,
  roundMoney,
  getDatePartsInTimeZone,
  zonedTimeToUtc,
} = require('../utils/dashboardMetrics');

function resolveDateRange(query = {}, timeZone = 'UTC') {
  if (query.startDate && query.endDate) {
    const start = startOfDayInTimeZone(new Date(query.startDate), timeZone);
    const end = endOfDayInTimeZone(new Date(query.endDate), timeZone);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && start <= end) {
      return { start, end, label: 'Custom range' };
    }
  }
  return null;
}

async function aggregatePeriodMetrics(sellerId, start, end) {
  const match = {
    sellerId,
    purchaseDate: { $gte: start, $lte: end },
  };

  const [stats] = await Order.aggregate([
    { $match: match },
    ORDER_METRICS_FIELDS,
    {
      $group: {
        _id: null,
        sales: { $sum: '$resolvedSales' },
        orders: {
          $sum: {
            $cond: [{ $eq: ['$isCancelledOrder', false] }, 1, 0],
          },
        },
        units: {
          $sum: {
            $cond: [{ $eq: ['$isCancelledOrder', false] }, '$resolvedUnits', 0],
          },
        },
        refunds: { $sum: { $cond: ['$isRefundLike', 1, 0] } },
        returnedUnits: {
          $sum: {
            $cond: ['$isRefundLike', '$resolvedUnits', 0],
          },
        },
        referralFees: { $sum: '$resolvedReferralFees' },
        fulfillmentFees: { $sum: '$resolvedFulfillmentFees' },
        cogs: { $sum: '$resolvedCogs' },
      },
    },
  ]);

  const row = stats || {
    sales: 0,
    orders: 0,
    units: 0,
    refunds: 0,
    returnedUnits: 0,
    referralFees: 0,
    fulfillmentFees: 0,
    cogs: 0,
  };

  const sales = roundMoney(row.sales);
  const amazonFees = roundMoney(row.referralFees + row.fulfillmentFees);
  const cogs = roundMoney(row.cogs);
  const grossProfit = roundMoney(sales - amazonFees - cogs);

  return {
    sales,
    orders: row.orders || 0,
    units: row.units || 0,
    refunds: row.refunds || 0,
    returnedUnits: row.returnedUnits || 0,
    amazonFees,
    referralFees: roundMoney(row.referralFees),
    fulfillmentFees: roundMoney(row.fulfillmentFees),
    cogs,
    grossProfit,
    netProfit: grossProfit,
    estimatedPayout: roundMoney(Math.max(sales - amazonFees, 0)),
    margin: sales > 0 ? roundMoney((grossProfit / sales) * 100) : 0,
    sellableReturnsPct:
      row.units > 0 ? roundMoney(((row.returnedUnits || 0) / row.units) * 100) : 0,
    refundRate: row.orders > 0 ? roundMoney(((row.refunds || 0) / row.orders) * 100) : 0,
  };
}

async function getAdSpendForPeriod(sellerId, start, end) {
  const result = await Ad.aggregate([
    {
      $match: {
        sellerId,
        $or: [
          { startDate: { $gte: start, $lte: end } },
          { endDate: { $gte: start, $lte: end } },
          {
            $and: [
              { startDate: { $lte: start } },
              { $or: [{ endDate: { $gte: end } }, { endDate: null }] },
            ],
          },
        ],
      },
    },
    { $group: { _id: null, totalSpend: { $sum: { $ifNull: ['$spend.amount', 0] } } } },
  ]);

  return roundMoney(result[0]?.totalSpend || 0);
}

function pctChange(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return roundMoney(((current - previous) / previous) * 100);
}

function applyForecast(metrics, forecastDays, elapsedDays) {
  if (!elapsedDays || elapsedDays <= 0) return metrics;
  const factor = forecastDays / elapsedDays;
  return {
    ...metrics,
    sales: roundMoney(metrics.sales * factor),
    orders: Math.round(metrics.orders * factor),
    units: Math.round(metrics.units * factor),
    refunds: Math.round(metrics.refunds * factor),
    grossProfit: roundMoney(metrics.grossProfit * factor),
    netProfit: roundMoney(metrics.netProfit * factor),
    estimatedPayout: roundMoney(metrics.estimatedPayout * factor),
    adCost: roundMoney(metrics.adCost * factor),
    isForecast: true,
  };
}

async function buildPeriodTile(sellerId, period) {
  const metrics = await aggregatePeriodMetrics(sellerId, period.start, period.end);
  const adCost = await getAdSpendForPeriod(sellerId, period.start, period.end);
  metrics.adCost = adCost;
  metrics.netProfit = roundMoney(metrics.grossProfit - adCost);
  metrics.margin = metrics.sales > 0 ? roundMoney((metrics.netProfit / metrics.sales) * 100) : 0;

  const compareMetrics = period.compareStart
    ? await aggregatePeriodMetrics(sellerId, period.compareStart, period.compareEnd)
    : null;

  let tileMetrics = { ...metrics };
  if (period.forecastDays && period.elapsedDays) {
    tileMetrics = applyForecast(metrics, period.forecastDays, period.elapsedDays);
    tileMetrics.margin =
      tileMetrics.sales > 0 ? roundMoney((tileMetrics.netProfit / tileMetrics.sales) * 100) : 0;
  }

  const compareAdCost =
    period.compareStart && period.compareEnd
      ? await getAdSpendForPeriod(sellerId, period.compareStart, period.compareEnd)
      : 0;

  return {
    key: period.key,
    label: period.label,
    startDate: period.start,
    endDate: period.end,
    metrics: tileMetrics,
    changes:
      compareMetrics && !period.forecastDays
        ? {
            sales: pctChange(metrics.sales, compareMetrics.sales),
            orders: pctChange(metrics.orders, compareMetrics.orders),
            units: pctChange(metrics.units, compareMetrics.units),
            grossProfit: pctChange(metrics.grossProfit, compareMetrics.grossProfit),
            netProfit: pctChange(
              metrics.netProfit,
              compareMetrics.grossProfit - compareAdCost,
            ),
          }
        : null,
  };
}

async function aggregateProductPerformance(sellerId, start, end, search = '') {
  const match = {
    sellerId,
    purchaseDate: { $gte: start, $lte: end },
    orderStatus: { $nin: CANCELLED_ORDER_STATUSES },
  };

  const pipeline = [
    { $match: match },
    { $unwind: '$orderItems' },
  ];

  if (search) {
    const regex = new RegExp(search, 'i');
    pipeline.push({
      $match: {
        $or: [
          { 'orderItems.asin': regex },
          { 'orderItems.sellerSku': regex },
          { 'orderItems.title': regex },
        ],
      },
    });
  }

  pipeline.push(
    {
      $addFields: {
        lineSales: {
          $max: [
            0,
            {
              $subtract: [
                { $ifNull: ['$orderItems.itemSubtotal.amount', 0] },
                { $ifNull: ['$orderItems.promotionDiscount.amount', 0] },
              ],
            },
          ],
        },
      },
    },
    {
      $group: {
        _id: {
          asin: '$orderItems.asin',
          sku: '$orderItems.sellerSku',
          title: '$orderItems.title',
        },
        unitsSold: { $sum: { $ifNull: ['$orderItems.quantityOrdered', 0] } },
        sales: { $sum: '$lineSales' },
        refunds: {
          $sum: {
            $cond: [
              { $eq: ['$hasCustomerReturn', true] },
              { $ifNull: ['$orderItems.quantityOrdered', 0] },
              0,
            ],
          },
        },
        referralFees: { $sum: { $ifNull: ['$orderItems.referralFee.amount', 0] } },
        fulfillmentFees: { $sum: { $ifNull: ['$orderItems.fulfillmentFee.amount', 0] } },
        cogs: { $sum: { $ifNull: ['$orderItems.costOfGoodsSold.amount', 0] } },
        orders: { $addToSet: '$amazonOrderId' },
      },
    },
    {
      $addFields: {
        orders: { $size: '$orders' },
        amazonFees: { $add: ['$referralFees', '$fulfillmentFees'] },
        grossProfit: {
          $subtract: ['$sales', { $add: ['$referralFees', '$fulfillmentFees', '$cogs'] }],
        },
      },
    },
    {
      $addFields: {
        netProfit: '$grossProfit',
        margin: {
          $cond: [{ $gt: ['$sales', 0] }, { $multiply: [{ $divide: ['$grossProfit', '$sales'] }, 100] }, 0],
        },
        sellableReturnsPct: {
          $cond: [{ $gt: ['$unitsSold', 0] }, { $multiply: [{ $divide: ['$refunds', '$unitsSold'] }, 100] }, 0],
        },
        roi: {
          $cond: [{ $gt: ['$cogs', 0] }, { $multiply: [{ $divide: ['$grossProfit', '$cogs'] }, 100] }, 0],
        },
        avgSellingPrice: {
          $cond: [{ $gt: ['$unitsSold', 0] }, { $divide: ['$sales', '$unitsSold'] }, 0],
        },
      },
    },
    {
      $facet: {
        rows: [{ $sort: { sales: -1 } }, { $limit: 100 }],
        totals: [
          {
            $group: {
              _id: null,
              sales: { $sum: '$sales' },
              unitsSold: { $sum: '$unitsSold' },
            },
          },
        ],
      },
    },
  );

  const [facetResult] = await Order.aggregate(pipeline);
  const rows = facetResult?.rows || [];
  const periodTotals = facetResult?.totals?.[0] || { sales: 0, unitsSold: 0 };
  const skus = rows.map((row) => row._id.sku).filter(Boolean);
  const asins = rows.map((row) => row._id.asin).filter(Boolean);

  const products = await Product.find({
    sellerId,
    $or: [{ sku: { $in: skus } }, { asin: { $in: asins } }],
  })
    .select('sku asin title price inventory images fulfillmentType')
    .lean();

  const productByKey = new Map();
  for (const product of products) {
    if (product.sku) productByKey.set(`sku:${product.sku}`, product);
    if (product.asin) productByKey.set(`asin:${product.asin}`, product);
  }

  return {
    products: rows.map((row) => {
      const product =
        productByKey.get(`sku:${row._id.sku}`) || productByKey.get(`asin:${row._id.asin}`) || null;

      return {
        asin: row._id.asin,
        sku: row._id.sku,
        title: row._id.title || product?.title || 'Unknown product',
        image: product?.images?.[0]?.url || null,
        price: roundMoney(product?.price?.amount || row.avgSellingPrice || 0),
        cogs: roundMoney(row.cogs),
        cogsPerUnit: row.unitsSold > 0 ? roundMoney(row.cogs / row.unitsSold) : 0,
        fbaStock: product?.inventory?.fulfillableQuantity ?? product?.inventory?.quantity ?? null,
        fulfillmentType: product?.fulfillmentType || product?.inventory?.fulfillmentChannel || null,
        unitsSold: row.unitsSold,
        refunds: row.refunds,
        sales: roundMoney(row.sales),
        ads: 0,
        sellableReturnsPct: roundMoney(row.sellableReturnsPct),
        grossProfit: roundMoney(row.grossProfit),
        netProfit: roundMoney(row.netProfit),
        margin: roundMoney(row.margin),
        roi: roundMoney(row.roi),
        avgSellingPrice: roundMoney(row.avgSellingPrice),
        orders: row.orders,
      };
    }),
    periodTotals: {
      sales: roundMoney(periodTotals.sales),
      unitsSold: periodTotals.unitsSold || 0,
    },
  };
}

async function aggregateOrderItems(sellerId, start, end, search = '') {
  const match = {
    sellerId,
    purchaseDate: { $gte: start, $lte: end },
    orderStatus: { $nin: CANCELLED_ORDER_STATUSES },
  };

  const pipeline = [{ $match: match }, { $unwind: '$orderItems' }];

  if (search) {
    const regex = new RegExp(search, 'i');
    pipeline.push({
      $match: {
        $or: [
          { amazonOrderId: regex },
          { 'orderItems.asin': regex },
          { 'orderItems.sellerSku': regex },
          { 'orderItems.title': regex },
        ],
      },
    });
  }

  pipeline.push(
    {
      $project: {
        amazonOrderId: 1,
        purchaseDate: 1,
        orderStatus: 1,
        hasCustomerReturn: 1,
        item: '$orderItems',
        lineSales: {
          $max: [
            0,
            {
              $subtract: [
                { $ifNull: ['$orderItems.itemSubtotal.amount', 0] },
                { $ifNull: ['$orderItems.promotionDiscount.amount', 0] },
              ],
            },
          ],
        },
      },
    },
    { $sort: { purchaseDate: -1 } },
    { $limit: 100 },
  );

  const rows = await Order.aggregate(pipeline);
  return rows.map((row) => ({
    orderId: row.amazonOrderId,
    purchaseDate: row.purchaseDate,
    orderStatus: row.orderStatus,
    hasReturn: Boolean(row.hasCustomerReturn),
    asin: row.item?.asin,
    sku: row.item?.sellerSku,
    title: row.item?.title,
    quantity: row.item?.quantityOrdered || 0,
    sales: roundMoney(row.lineSales),
    image: row.item?.productImage || null,
  }));
}

async function getTopSalesChannel(sellerId) {
  const [row] = await Order.aggregate([
    { $match: { sellerId } },
    { $group: { _id: '$salesChannel', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 1 },
  ]);
  return row?._id || null;
}

async function getDashboardOverview(sellerId, query = {}, user = null) {
  const topSalesChannel = await getTopSalesChannel(sellerId);
  const timeZone = resolveDashboardTimeZone(user || {}, query, topSalesChannel);
  const presets = buildPresetPeriods(new Date(), timeZone);
  const customRange = resolveDateRange(query, timeZone);
  const tablePeriod = customRange || presets.monthToDate;
  const search = String(query.search || '').trim();

  const tiles = await Promise.all(
    Object.values(presets).map((period) => buildPeriodTile(sellerId, period)),
  );

  const [productResult, orderItems, dailySales, monthlySales, tablePeriodMetrics] = await Promise.all([
    aggregateProductPerformance(sellerId, tablePeriod.start, tablePeriod.end, search),
    aggregateOrderItems(sellerId, tablePeriod.start, tablePeriod.end, search),
    Order.aggregate([
      {
        $match: {
          sellerId,
          purchaseDate: { $gte: tablePeriod.start, $lte: tablePeriod.end },
        },
      },
      ORDER_METRICS_FIELDS,
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$purchaseDate', timezone: timeZone } },
          sales: { $sum: '$resolvedSales' },
          orders: { $sum: { $cond: [{ $eq: ['$isCancelledOrder', false] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Order.aggregate([
      {
        $match: {
          sellerId,
          purchaseDate: {
            $gte: (() => {
              const parts = getDatePartsInTimeZone(new Date(), timeZone);
              const month = parts.month - 5;
              const year = month < 1 ? parts.year - 1 : parts.year;
              const normalizedMonth = month < 1 ? month + 12 : month;
              return zonedTimeToUtc({ year, month: normalizedMonth, day: 1 }, timeZone);
            })(),
            $lte: new Date(),
          },
        },
      },
      ORDER_METRICS_FIELDS,
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$purchaseDate', timezone: timeZone } },
          sales: { $sum: '$resolvedSales' },
          orders: { $sum: { $cond: [{ $eq: ['$isCancelledOrder', false] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    aggregatePeriodMetrics(sellerId, tablePeriod.start, tablePeriod.end),
  ]);

  const products = productResult.products;
  const productTableSales = productResult.periodTotals.sales;
  const productTableUnits = productResult.periodTotals.unitsSold;

  const listedClauses = [{ sellerId }];
  applyListingFilter(listedClauses, 'listed');
  const listedProducts = await Product.countDocuments({ $and: listedClauses });

  const mtdTile = tiles.find((tile) => tile.key === 'monthToDate');

  return {
    currency: 'USD',
    timeZone,
    generatedAt: new Date(),
    tablePeriod: {
      label: tablePeriod.label,
      startDate: tablePeriod.start,
      endDate: tablePeriod.end,
    },
    tiles,
    products,
    orderItems,
    charts: {
      dailySales: dailySales.map((row) => ({
        ...row,
        sales: roundMoney(row.sales),
      })),
      monthlySales: monthlySales.map((row) => ({
        ...row,
        sales: roundMoney(row.sales),
      })),
    },
    reconciliation: {
      tablePeriodSales: tablePeriodMetrics.sales,
      productTableSales,
      productTableUnits,
      tablePeriodOrders: tablePeriodMetrics.orders,
      tablePeriodUnits: tablePeriodMetrics.units,
      monthToDateTileSales: mtdTile?.metrics.sales || 0,
      salesDelta: roundMoney(Math.abs(tablePeriodMetrics.sales - productTableSales)),
    },
    meta: {
      listedProducts,
      topSalesChannel,
    },
  };
}

module.exports = {
  getDashboardOverview,
  buildPresetPeriods,
};
