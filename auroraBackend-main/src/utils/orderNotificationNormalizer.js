/**
 * Map Amazon Orders API + items into Aurora Order document shape.
 */
const { normalizeOrderStatus, normalizeFulfillmentChannel } = require('./normalizeOrderStatus');
const { computeItemFees } = require('./orderItemFees');

function normalizeShippingAddress(address = {}) {
  return {
    name: address.Name || address.name || '',
    addressLine1: address.AddressLine1 || address.addressLine1 || '',
    addressLine2: address.AddressLine2 || address.addressLine2 || '',
    city: address.City || address.city || '',
    stateOrRegion: address.StateOrRegion || address.stateOrRegion || '',
    postalCode: address.PostalCode || address.postalCode || '',
    countryCode: address.CountryCode || address.countryCode || '',
    phone: address.Phone || address.phone || '',
  };
}

function normalizeOrderItems(orderItems = [], feeMap = null, fulfillmentChannel = null) {
  const channel = String(fulfillmentChannel || '').toUpperCase();
  const isFba = channel.includes('AFN') || channel.includes('AMAZON');

  return orderItems.map((item) => {
    const quantityOrdered = item.QuantityOrdered ?? item.quantityOrdered ?? 0;
    const itemPrice = {
      amount: Number(item.ItemPrice?.Amount ?? item.itemPrice?.amount ?? 0) || 0,
      currencyCode: item.ItemPrice?.CurrencyCode ?? item.itemPrice?.currencyCode ?? 'USD',
    };
    const fees = computeItemFees(
      {
        sku: item.SellerSKU || item.sellerSku,
        quantity: quantityOrdered || 1,
        lineTotal: itemPrice.amount,
        currency: itemPrice.currencyCode,
        isFba,
      },
      feeMap,
    );

    return {
      asin: item.ASIN || item.asin,
      sellerSku: item.SellerSKU || item.sellerSku,
      title: item.Title || item.title,
      itemStatus: normalizeOrderStatus(item.ItemStatus || item.itemStatus),
      quantityOrdered,
      quantityShipped: item.QuantityShipped ?? item.quantityShipped ?? 0,
      itemPrice,
      itemTax: {
        amount: Number(item.ItemTax?.Amount ?? item.itemTax?.amount ?? 0) || 0,
        currencyCode: item.ItemTax?.CurrencyCode ?? item.itemTax?.currencyCode ?? itemPrice.currencyCode,
      },
      shippingPrice: {
        amount: item.ShippingPrice?.Amount ?? item.shippingPrice?.amount ?? 0,
        currencyCode: item.ShippingPrice?.CurrencyCode ?? item.shippingPrice?.currencyCode ?? 'USD',
      },
      isGift: item.IsGift ?? item.isGift ?? false,
      referralFee: fees.referralFee,
      fulfillmentFee: fees.fulfillmentFee,
      costOfGoodsSold: fees.costOfGoodsSold,
      itemSubtotal: {
        amount: itemPrice.amount,
        currencyCode: itemPrice.currencyCode,
      },
    };
  });
}

function normalizeOrderForDb(sellerId, orderDetails, feeMap = null) {
  const order = orderDetails || {};
  const fulfillmentChannel = normalizeFulfillmentChannel(
    order.fulfillmentChannel || order.FulfillmentChannel,
  );

  return {
    sellerId,
    amazonOrderId: order.amazonOrderId || order.AmazonOrderId,
    sellerOrderId: order.sellerOrderId || order.SellerOrderId || '',
    purchaseDate: order.purchaseDate ? new Date(order.purchaseDate) : new Date(order.PurchaseDate),
    lastUpdateDate: order.lastUpdateDate
      ? new Date(order.lastUpdateDate)
      : order.LastUpdateDate
        ? new Date(order.LastUpdateDate)
        : undefined,
    orderStatus: normalizeOrderStatus(order.orderStatus || order.OrderStatus),
    fulfillmentChannel,
    salesChannel: order.salesChannel || order.SalesChannel,
    shipServiceLevel: order.shipServiceLevel || order.ShipServiceLevel,
    shippingAddress: normalizeShippingAddress(order.shippingAddress || order.ShippingAddress),
    orderTotal: {
      amount: order.orderTotal?.Amount ?? order.orderTotal?.amount ?? 0,
      currencyCode: order.orderTotal?.CurrencyCode ?? order.orderTotal?.currencyCode ?? 'USD',
    },
    numberOfItemsShipped: order.numberOfItemsShipped ?? order.NumberOfItemsShipped ?? 0,
    numberOfItemsUnshipped: order.numberOfItemsUnshipped ?? order.NumberOfItemsUnshipped ?? 0,
    paymentMethod: order.paymentMethod || order.PaymentMethod,
    paymentMethodDetails: order.paymentMethodDetails || order.PaymentMethodDetails,
    isBusinessOrder: order.isBusinessOrder ?? order.IsBusinessOrder ?? false,
    isPrime: order.isPrime ?? order.IsPrime ?? false,
    isReplacementOrder: order.isReplacementOrder ?? order.IsReplacementOrder ?? false,
    isGlobalExpressEnabled: order.isGlobalExpressEnabled ?? order.IsGlobalExpressEnabled ?? false,
    replacedOrderId: order.replacedOrderId || order.ReplacedOrderId,
    isISPU: order.isISPU ?? order.IsISPU ?? false,
    merchantFulfillmentData: order.merchantFulfillmentData || order.MerchantFulfillmentData,
    hasRegulatedItems: order.hasRegulatedItems ?? order.HasRegulatedItems ?? false,
    electronicInvoiceStatus: order.electronicInvoiceStatus || order.ElectronicInvoiceStatus,
    marketplaceId: order.marketplaceId || order.MarketplaceId,
    buyerEmail: order.buyerEmail || order.BuyerEmail,
    buyerName: order.buyerName || order.BuyerName,
    buyerCounty: order.buyerCounty || order.BuyerCounty,
    buyerTaxInfo: order.buyerTaxInfo || order.BuyerTaxInfo,
    orderItems: normalizeOrderItems(order.orderItems || [], feeMap, fulfillmentChannel),
    lastSynced: new Date(),
  };
}

module.exports = {
  normalizeOrderForDb,
  normalizeOrderItems,
};
