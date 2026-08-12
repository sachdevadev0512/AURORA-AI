const NOTIFICATION_TYPES_BY_CATEGORY = {
  orders: [
    'order_change',
    'amazon_order',
    'amazon_orders_batch',
    'orders_sync',
  ],
  products: ['product_fee_change', 'inventory_sync'],
  ads: ['ads_sync_error'],
  shipments: ['shipment_delayed'],
};

const VALID_CATEGORIES = ['orders', 'products', 'ads', 'shipments'];

function isValidCategory(category) {
  return VALID_CATEGORIES.includes(String(category || '').toLowerCase());
}

function getTypesForCategory(category) {
  const key = String(category || '').toLowerCase();
  return NOTIFICATION_TYPES_BY_CATEGORY[key] || null;
}

function buildCategoryQuery(category, { entityId } = {}) {
  if (!isValidCategory(category)) {
    return {};
  }

  const types = getTypesForCategory(category);
  const base = { type: { $in: types } };

  if (entityId && category === 'products') {
    return {
      ...base,
      'metadata.productId': String(entityId),
    };
  }

  if (entityId && category === 'orders') {
    return {
      $and: [
        base,
        {
          $or: [
            { 'metadata.orderId': String(entityId) },
            { link: `/orders/${entityId}` },
          ],
        },
      ],
    };
  }

  return base;
}

module.exports = {
  NOTIFICATION_TYPES_BY_CATEGORY,
  VALID_CATEGORIES,
  isValidCategory,
  getTypesForCategory,
  buildCategoryQuery,
};
