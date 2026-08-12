const { normalizeOrderStatus, normalizeFulfillmentChannel } = require('./normalizeOrderStatus');
const { computeItemFees } = require('./orderItemFees');

function parseMoney(value, currency = 'USD') {
  const amount = Number.parseFloat(String(value || '0').replace(/,/g, '')) || 0;
  return { amount, currencyCode: currency || 'USD' };
}

function groupRowsByOrderId(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const orderId = row['amazon-order-id'];
    if (!orderId) continue;
    if (!grouped.has(orderId)) grouped.set(orderId, []);
    grouped.get(orderId).push(row);
  }
  return grouped;
}

function buildOrderItemFromReportRow(row, currency, feeMap = null) {
  // Flat-file `item-price` is already the line total (not unit × qty).
  const itemPrice = parseMoney(row['item-price'], currency);
  const quantityOrdered = Number.parseInt(row.quantity, 10) || 1;
  const fulfillment = String(row['fulfillment-channel'] || '').toUpperCase();
  const isFba = fulfillment.includes('AFN') || fulfillment.includes('AMAZON');
  const fees = computeItemFees(
    {
      sku: row.sku || null,
      quantity: quantityOrdered,
      lineTotal: itemPrice.amount,
      currency,
      isFba,
    },
    feeMap,
  );

  return {
    asin: row.asin || null,
    sellerSku: row.sku || null,
    title: row['product-name'] || null,
    itemStatus:
      normalizeOrderStatus(row['item-status'] || row['order-status']) ||
      row['item-status'] ||
      row['order-status'] ||
      null,
    quantityOrdered,
    quantityShipped:
      String(row['item-status'] || '').toLowerCase() === 'shipped' ? quantityOrdered : 0,
    itemPrice,
    itemTax: parseMoney(row['item-tax'], currency),
    shippingPrice: parseMoney(row['shipping-price'], currency),
    shippingTax: parseMoney(row['shipping-tax'], currency),
    promotionDiscount: parseMoney(row['item-promotion-discount'], currency),
    promotionIds: row['promotion-ids']
      ? String(row['promotion-ids'])
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : [],
    codFee: { amount: 0, currencyCode: currency },
    codFeeDiscount: { amount: 0, currencyCode: currency },
    isGift: false,
    conditionId: null,
    conditionSubtypeId: null,
    fnsku: null,
    productImage: null,
    referralFee: fees.referralFee,
    fulfillmentFee: fees.fulfillmentFee,
    costOfGoodsSold: fees.costOfGoodsSold,
    itemSubtotal: {
      amount: itemPrice.amount,
      currencyCode: currency,
    },
  };
}

function buildOrderDocumentFromReportRows(sellerId, rows, feeMap = null) {
  const first = rows[0];
  const currency = first.currency || 'USD';
  const orderItems = rows.map((row) => buildOrderItemFromReportRow(row, currency, feeMap));
  const orderTotalAmount = orderItems.reduce((sum, item) => sum + item.itemSubtotal.amount, 0);
  const numberOfItemsShipped = orderItems.reduce(
    (sum, item) => sum + (item.quantityShipped || 0),
    0,
  );

  return {
    sellerId,
    amazonOrderId: first['amazon-order-id'],
    sellerOrderId: first['merchant-order-id'] || null,
    purchaseDate: new Date(first['purchase-date']),
    lastUpdateDate: first['last-updated-date'] ? new Date(first['last-updated-date']) : null,
    orderStatus: normalizeOrderStatus(first['order-status']),
    fulfillmentChannel: normalizeFulfillmentChannel(first['fulfillment-channel']),
    salesChannel: first['sales-channel'] || null,
    orderChannel: first['order-channel'] || null,
    shipServiceLevel: first['ship-service-level'] || null,
    shipmentServiceLevelCategory: null,
    orderTotal: { amount: orderTotalAmount, currencyCode: currency },
    numberOfItemsShipped,
    numberOfItemsUnshipped: Math.max(
      orderItems.reduce((sum, item) => sum + (item.quantityOrdered || 0), 0) - numberOfItemsShipped,
      0,
    ),
    paymentExecutionDetail: [],
    paymentMethod: null,
    paymentMethodDetails: null,
    marketplaceId: first['marketplace-id'] || null,
    marketplaceName: first['sales-channel'] || null,
    buyerEmail: first['buyer-email'] || null,
    buyerName: first['buyer-name'] || first['recipient-name'] || null,
    buyerCounty: null,
    buyerTaxInfo: null,
    shippingAddress: {
      name: first['recipient-name'] || '',
      addressLine1: first['ship-address-1'] || '',
      addressLine2: first['ship-address-2'] || '',
      city: first['ship-city'] || '',
      stateOrRegion: first['ship-state'] || '',
      postalCode: first['ship-postal-code'] || '',
      countryCode: first['ship-country'] || '',
      phone: first['ship-phone-number'] || '',
    },
    orderItems,
    isBusinessOrder: String(first['is-business-order'] || '').toLowerCase() === 'true',
    isPrime: false,
    isPremiumOrder: String(first['is-premium-order'] || '').toLowerCase() === 'true',
    isGlobalExpressEnabled: false,
    isSoldByAB: false,
    isIBA: false,
    isReplacementOrder: false,
    replacedOrderId: null,
    promiseResponseDueDate: null,
    isEstimatedShipDateSet: false,
    isSoldBySeller: false,
    defaultShipFromLocationAddress: null,
    lastSynced: new Date(),
  };
}

function parseFlatFileOrdersReport(rows, sellerId, feeMap = null) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const grouped = groupRowsByOrderId(rows);
  const orders = [];

  for (const orderRows of grouped.values()) {
    try {
      orders.push(buildOrderDocumentFromReportRows(sellerId, orderRows, feeMap));
    } catch (error) {
      const orderId = orderRows[0]?.['amazon-order-id'] || 'unknown';
      console.warn(`[OrderSync] Failed to parse report order ${orderId}:`, error.message);
    }
  }

  return orders;
}

module.exports = {
  parseFlatFileOrdersReport,
  buildOrderDocumentFromReportRows,
  buildOrderItemFromReportRow,
};
