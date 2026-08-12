/**
 * Maps Aurora order list filters to MongoDB queries.
 * Amazon OrderStatus does not include Delivered/Returned — we approximate where possible.
 */
const {
  CANCELLED_STATUS_VARIANTS,
  SHIPPED_STATUS_VARIANTS,
  buildFulfillmentChannelQuery,
} = require('./normalizeOrderStatus');

const ORDER_STATUS_FILTER_KEYS = [
  'pending',
  'unshipped',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
];

function buildOrderStatusQuery(statusParam) {
  if (!statusParam) return null;

  const normalized = String(statusParam).trim().toLowerCase();

  switch (normalized) {
    case 'pending':
      return { orderStatus: { $in: ['Pending', 'InvoiceUnconfirmed'] } };
    case 'unshipped':
      return { orderStatus: { $in: ['Unshipped', 'PartiallyShipped'] } };
    case 'shipped':
      return {
        $or: [
          { orderStatus: 'PartiallyShipped' },
          { orderStatus: { $in: SHIPPED_STATUS_VARIANTS }, numberOfItemsUnshipped: { $gt: 0 } },
        ],
      };
    case 'delivered':
      return {
        orderStatus: { $in: SHIPPED_STATUS_VARIANTS },
        $or: [
          { numberOfItemsUnshipped: 0 },
          { numberOfItemsUnshipped: null },
          { numberOfItemsUnshipped: { $exists: false } },
        ],
      };
    case 'cancelled':
    case 'canceled':
      return { orderStatus: { $in: CANCELLED_STATUS_VARIANTS.concat(['Unfulfillable']) } };
    case 'returned':
      return {
        $or: [
          { hasCustomerReturn: true },
          { hasRefund: true },
          { isReplacementOrder: true },
          { replacedOrderId: { $exists: true, $nin: [null, ''] } },
          { 'orderItems.itemStatus': { $regex: /return/i } },
        ],
      };
    default:
      return { orderStatus: String(statusParam).trim() };
  }
}

function applyOrderStatusFilter(baseQuery, statusParam) {
  const statusQuery = buildOrderStatusQuery(statusParam);
  if (!statusQuery) return baseQuery;

  if (statusQuery.$or && baseQuery.$or) {
    const { $or: searchOr, ...rest } = baseQuery;
    return { ...rest, $and: [{ $or: searchOr }, statusQuery] };
  }

  if (statusQuery.$or) {
    return { ...baseQuery, ...statusQuery };
  }

  return { ...baseQuery, ...statusQuery };
}

function applyFulfillmentChannelFilter(baseQuery, channelParam) {
  const channelQuery = buildFulfillmentChannelQuery(channelParam);
  if (!channelQuery) return baseQuery;

  if (typeof channelQuery === 'object' && channelQuery.$in) {
    return { ...baseQuery, fulfillmentChannel: channelQuery };
  }

  return { ...baseQuery, fulfillmentChannel: channelQuery };
}

/** Seller Central "Refine by → Sales channel" labels → stored salesChannel values. */
const SALES_CHANNEL_FILTER_ALIASES = {
  'Amazon.com': ['Amazon.com'],
  'Amazon.ca': ['Amazon.ca'],
  'Amazon.com.mx': ['Amazon.com.mx', 'Amazon.mx'],
  // Flat-file/API often stores plain "Non-Amazon" for US multi-channel orders.
  'Non-Amazon US': ['Non-Amazon US', 'Non-Amazon'],
  'Non-Amazon CA': ['Non-Amazon CA'],
  'Non-Amazon MX': ['Non-Amazon MX'],
};

function parseCsvParam(param) {
  if (param == null || param === '') return [];
  if (Array.isArray(param)) {
    return param.map((v) => String(v).trim()).filter(Boolean);
  }
  return String(param)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function buildSalesChannelQuery(salesChannelParam) {
  const selected = parseCsvParam(salesChannelParam);
  if (selected.length === 0) return null;

  const values = new Set();
  for (const key of selected) {
    const aliases = SALES_CHANNEL_FILTER_ALIASES[key] || [key];
    for (const value of aliases) values.add(value);
  }
  const list = Array.from(values);
  if (list.length === 0) return null;
  if (list.length === 1) return { salesChannel: list[0] };
  return { salesChannel: { $in: list } };
}

/**
 * Seller Central "Refine by → Order type".
 * Business → isBusinessOrder.
 * Subscribe & Save → promotionIds containing "Subscribe and/& Save".
 */
function buildOrderTypeQuery(orderTypeParam) {
  const selected = parseCsvParam(orderTypeParam).map((v) =>
    v.toLowerCase().replace(/[\s_]+/g, ''),
  );
  if (selected.length === 0) return null;

  const clauses = [];
  if (selected.some((v) => v === 'business' || v === 'businesscustomer')) {
    clauses.push({ isBusinessOrder: true });
  }
  if (
    selected.some(
      (v) =>
        v === 'subscribeandsave' ||
        v === 'sns' ||
        v === 'subscribe&save',
    )
  ) {
    clauses.push({
      'orderItems.promotionIds': { $regex: /subscribe\s*(and|&)\s*save/i },
    });
  }

  if (clauses.length === 0) return null;
  if (clauses.length === 1) return clauses[0];
  return { $or: clauses };
}

/** Merge a clause that may contain $or/$and without clobbering existing $or. */
function applyMongoClause(baseQuery, clause) {
  if (!clause) return baseQuery;

  const needsAnd = Boolean(
    clause.$or || baseQuery.$or || clause.$and || baseQuery.$and,
  );
  if (!needsAnd) {
    return { ...baseQuery, ...clause };
  }

  const parts = [];
  if (baseQuery.$and) {
    parts.push(...baseQuery.$and);
    const { $and, ...rest } = baseQuery;
    if (Object.keys(rest).length > 0) parts.push(rest);
  } else {
    parts.push(baseQuery);
  }
  parts.push(clause);
  return { $and: parts };
}

function applySalesChannelFilter(baseQuery, salesChannelParam) {
  return applyMongoClause(baseQuery, buildSalesChannelQuery(salesChannelParam));
}

function applyOrderTypeFilter(baseQuery, orderTypeParam) {
  return applyMongoClause(baseQuery, buildOrderTypeQuery(orderTypeParam));
}

function isReturnedStatusFilter(statusParam) {
  return String(statusParam || '').trim().toLowerCase() === 'returned';
}

/**
 * Date range filters by purchaseDate on every tab, including Returned.
 * (Per product owner request: the Returned tab window matches the order's
 * purchase date, not the return date.)
 */
function applyOrderListDateRange(baseQuery, dateRange) {
  if (!dateRange) return baseQuery;

  return { ...baseQuery, purchaseDate: dateRange };
}

module.exports = {
  ORDER_STATUS_FILTER_KEYS,
  SALES_CHANNEL_FILTER_ALIASES,
  buildOrderStatusQuery,
  applyOrderStatusFilter,
  applyFulfillmentChannelFilter,
  buildSalesChannelQuery,
  buildOrderTypeQuery,
  applySalesChannelFilter,
  applyOrderTypeFilter,
  applyMongoClause,
  isReturnedStatusFilter,
  applyOrderListDateRange,
};
