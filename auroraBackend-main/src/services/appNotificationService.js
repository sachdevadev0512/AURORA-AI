const AppNotification = require('../models/AppNotification');
const { buildCategoryQuery, isValidCategory } = require('../utils/notificationCategories');

/** Inbox + socket bell: never persist or emit these types. */
const SUPPRESSED_INBOX_TYPES = new Set(['ads_sync', 'amazon_live_enabled']);

function isSuppressedInboxType(type) {
  return SUPPRESSED_INBOX_TYPES.has(String(type || ''));
}

function applyInboxSuppression(query) {
  if (!query || typeof query !== 'object') return query;

  const next = { ...query };
  if (!next.type) {
    next.type = { $nin: [...SUPPRESSED_INBOX_TYPES] };
    return next;
  }

  if (next.type.$in) {
    const allowed = next.type.$in.filter((type) => !isSuppressedInboxType(type));
    next.type = allowed.length ? { $in: allowed } : { $in: ['__suppressed__'] };
    return next;
  }

  if (next.type.$nin) {
    next.type = {
      $nin: [...new Set([...next.type.$nin, ...SUPPRESSED_INBOX_TYPES])],
    };
    return next;
  }

  if (isSuppressedInboxType(next.type)) {
    next.type = { $in: ['__suppressed__'] };
  }

  return next;
}

const ORDER_CHANGE_LABELS = {
  OrderStatusChange: 'Status changed',
  BuyerRequestedChange: 'Buyer requested change',
  OrderStatusChangeNotification: 'Status changed',
};

function emitAppNotification(userId, notification) {
  if (!global.io || !notification) return;

  global.io.to(`user_${String(userId)}`).emit('appNotification', {
    ...notification,
    timestamp: notification.createdAt || new Date().toISOString(),
  });
}

function emitOrderUpdateSocket(userId, order, event = 'ORDER_CHANGE') {
  if (!global.io || !order) return;

  global.io.to(`user_${String(userId)}`).emit('orderUpdate', {
    event,
    order,
    status: order.orderStatus,
    timestamp: new Date().toISOString(),
  });
}

function formatAmazonOrderTitle(orderChangeType, orderStatus) {
  const changeLabel = orderChangeType
    ? ORDER_CHANGE_LABELS[orderChangeType] || orderChangeType
    : null;

  if (changeLabel) {
    return `Amazon: ${changeLabel}`;
  }

  return `Amazon: Order ${orderStatus || 'updated'}`;
}

/**
 * Amazon ORDER_CHANGE / live sync — socket + bell inbox.
 */
async function publishAmazonOrderUpdate(
  userId,
  order,
  { event = 'ORDER_CHANGE', orderChangeType = null } = {}
) {
  if (!order) return null;

  emitOrderUpdateSocket(userId, order, event);

  const amazonOrderId = order.amazonOrderId || order.AmazonOrderId;
  const orderStatus = order.orderStatus || order.OrderStatus || 'Updated';
  const orderDbId = order._id ? String(order._id) : null;

  return createNotification(userId, {
    source: 'amazon',
    type: 'amazon_order',
    title: formatAmazonOrderTitle(orderChangeType, orderStatus),
    message: `Order ${amazonOrderId} — ${orderStatus}`,
    link: orderDbId ? `/orders/${orderDbId}` : '/orders',
    metadata: {
      event,
      amazonOrderId,
      orderId: orderDbId,
      orderStatus,
      orderChangeType,
    },
  });
}

async function publishAmazonOrdersBatch(userId, { count, lookbackMinutes }) {
  if (!count || count < 1) return null;

  return createNotification(userId, {
    source: 'amazon',
    type: 'amazon_orders_batch',
    title: 'Amazon: Orders synced',
    message: `${count} recent order(s) pulled from Amazon`,
    link: '/orders',
    metadata: { count, lookbackMinutes },
  });
}

async function publishAmazonLiveEnabled(_userId) {
  return null;
}

async function publishProductFeeChange(userId, { product, change, title, message, link }) {
  if (!product || !change) return null;

  const productDbId = product._id ? String(product._id) : null;

  return createNotification(userId, {
    source: 'amazon',
    type: 'product_fee_change',
    title: title || `Amazon: Product fee changed (${change.asin})`,
    message:
      message ||
      `Inventory ${change.asin} — ${change.feeLabel || change.feeType} updated`,
    link: link || (productDbId ? `/products/${productDbId}` : '/products'),
    metadata: {
      event: 'PRODUCT_FEE_CHANGE',
      productId: productDbId,
      asin: change.asin,
      sku: change.sku || product.sku || null,
      feeType: change.feeType,
      feeLabel: change.feeLabel || change.feeType,
      changeType: change.changeType,
      oldAmount: change.oldAmount,
      newAmount: change.newAmount,
      currencyCode: change.currencyCode || 'USD',
    },
  });
}

async function createNotification(
  sellerId,
  { source = 'aurora', type, title, message, link = null, metadata = {} }
) {
  if (isSuppressedInboxType(type)) {
    return null;
  }

  const doc = await AppNotification.create({
    sellerId,
    source,
    type,
    title,
    message,
    link,
    metadata: { ...metadata, source },
    read: false,
  });

  const payload = {
    _id: String(doc._id),
    source: doc.source,
    type: doc.type,
    title: doc.title,
    message: doc.message,
    link: doc.link,
    read: doc.read,
    metadata: doc.metadata,
    createdAt: doc.createdAt.toISOString(),
  };

  emitAppNotification(sellerId, payload);
  return doc;
}

async function listNotifications(
  sellerId,
  { limit = 30, unreadOnly = false, category = null, entityId = null } = {},
) {
  const query = { sellerId };
  if (unreadOnly) query.read = false;

  if (isValidCategory(category)) {
    const categoryQuery = buildCategoryQuery(category, { entityId });
    Object.assign(query, categoryQuery);
  }

  const listQuery = applyInboxSuppression(query);

  const [items, unreadCount, total] = await Promise.all([
    AppNotification.find(listQuery).sort({ createdAt: -1 }).limit(limit).lean(),
    AppNotification.countDocuments({ ...listQuery, read: false }),
    AppNotification.countDocuments(listQuery),
  ]);

  return {
    notifications: items.map((n) => ({
      ...n,
      _id: String(n._id),
      source: n.source || n.metadata?.source || 'aurora',
      createdAt: n.createdAt?.toISOString?.() || n.createdAt,
    })),
    unreadCount,
    total,
    category: category || 'all',
  };
}

async function markAsRead(sellerId, notificationId) {
  return AppNotification.findOneAndUpdate(
    { _id: notificationId, sellerId },
    { read: true },
    { new: true }
  );
}

async function markAllAsRead(sellerId, { category = null, entityId = null } = {}) {
  const query = { sellerId, read: false };
  if (isValidCategory(category)) {
    Object.assign(query, buildCategoryQuery(category, { entityId }));
  }

  const result = await AppNotification.updateMany(applyInboxSuppression(query), { read: true });
  return result.modifiedCount;
}

module.exports = {
  createNotification,
  publishAmazonOrderUpdate,
  publishAmazonOrdersBatch,
  publishAmazonLiveEnabled,
  publishProductFeeChange,
  emitOrderUpdateSocket,
  listNotifications,
  markAsRead,
  markAllAsRead,
  emitAppNotification,
};
