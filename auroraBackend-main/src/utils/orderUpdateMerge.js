/**
 * Merge live ORDER_CHANGE updates into existing orders without wiping enriched data
 * from full syncs (fees, images, notes, returns).
 */

const PRESERVED_TOP_LEVEL_FIELDS = [
  'notes',
  'hasCustomerReturn',
  'customerReturns',
  'latestCustomerReturnDate',
  'hasRefund',
  'refunds',
  'latestRefundDate',
  'latestReturnedActivityDate',
  'marketplaceName',
  'orderChannel',
  'shipmentServiceLevelCategory',
  'paymentExecutionDetail',
  'isPremiumOrder',
  'isSoldByAB',
  'isIBA',
  'isSoldBySeller',
  'promiseResponseDueDate',
  'isEstimatedShipDateSet',
  'defaultShipFromLocationAddress',
];

const PRESERVED_SCALAR_FIELDS = [
  'buyerEmail',
  'buyerName',
  'buyerCounty',
  'buyerTaxInfo',
  'marketplaceId',
];

const ENRICHED_ITEM_FIELDS = [
  'itemTax',
  'shippingTax',
  'promotionDiscount',
  'promotionIds',
  'codFee',
  'codFeeDiscount',
  'conditionId',
  'conditionSubtypeId',
  'fnsku',
  'productImage',
  'referralFee',
  'fulfillmentFee',
  'costOfGoodsSold',
  'itemSubtotal',
];

function isEmptyValue(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object' && 'amount' in value) {
    return value.amount == null;
  }
  return false;
}

function orderItemKey(item = {}) {
  return `${String(item.asin || '').trim()}|${String(item.sellerSku || '').trim()}`;
}

function mergeOrderItems(existingItems = [], incomingItems = []) {
  const existingByKey = new Map(
    (existingItems || []).map((item) => [orderItemKey(item), item]),
  );

  return (incomingItems || []).map((incoming) => {
    const existing = existingByKey.get(orderItemKey(incoming));
    if (!existing) return incoming;

    const merged = { ...incoming };
    for (const field of ENRICHED_ITEM_FIELDS) {
      if (isEmptyValue(incoming[field]) && !isEmptyValue(existing[field])) {
        merged[field] = existing[field];
      }
    }
    return merged;
  });
}

function mergeOrderForLiveUpdate(existing, incoming) {
  if (!existing) return incoming;

  const merged = { ...incoming };

  for (const field of PRESERVED_TOP_LEVEL_FIELDS) {
    if (existing[field] != null) {
      merged[field] = existing[field];
    }
  }

  for (const field of PRESERVED_SCALAR_FIELDS) {
    if (isEmptyValue(incoming[field]) && !isEmptyValue(existing[field])) {
      merged[field] = existing[field];
    }
  }

  merged.orderItems = mergeOrderItems(existing.orderItems, incoming.orderItems);
  return merged;
}

async function upsertOrderFromLiveSync(Order, userId, orderData) {
  const existing = await Order.findOne({
    amazonOrderId: orderData.amazonOrderId,
    sellerId: userId,
  }).lean();

  const merged = mergeOrderForLiveUpdate(existing, orderData);

  return Order.findOneAndUpdate(
    { amazonOrderId: orderData.amazonOrderId, sellerId: userId },
    { $set: merged },
    { upsert: true, new: true, runValidators: true },
  );
}

module.exports = {
  mergeOrderForLiveUpdate,
  mergeOrderItems,
  upsertOrderFromLiveSync,
  isEmptyValue,
};
