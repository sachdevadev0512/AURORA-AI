const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  asin: String,
  sellerSku: String, // sku
  title: String, // product-name
  itemStatus: String,
  quantityOrdered: Number, // quantity
  quantityShipped: Number,
  itemPrice: {
    amount: Number,
    currencyCode: String,
  },
  itemTax: {
    amount: Number,
    currencyCode: String,
  },
  shippingPrice: {
    amount: Number,
    currencyCode: String,
  },
  shippingTax: {
    amount: Number,
    currencyCode: String,
  },
  promotionDiscount: {
    amount: Number,
    currencyCode: String,
  },
  promotionIds: [String], // promotion-ids
  codFee: {
    amount: Number,
    currencyCode: String,
  },
  codFeeDiscount: {
    amount: Number,
    currencyCode: String,
  },
  isGift: Boolean,
  conditionId: String,
  conditionSubtypeId: String,
  fnsku: String, // FNSKU
  productImage: String, // Product Image
  referralFee: {
    amount: Number,
    currencyCode: String,
  }, // Referral Fee
  fulfillmentFee: {
    amount: Number,
    currencyCode: String,
  }, // Fulfillment Fee
  costOfGoodsSold: {
    amount: Number,
    currencyCode: String,
  }, // Cost of goods sold
  itemSubtotal: {
    amount: Number,
    currencyCode: String,
  }, // Item-sub-total
});

const orderSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  amazonOrderId: {
    type: String,
    required: true,
    index: true,
  },
  sellerOrderId: String, // Seller Order ID
  purchaseDate: {
    type: Date,
    required: true,
  },
  lastUpdateDate: Date,
  orderStatus: {
    type: String,
    enum: ['Pending', 'Unshipped', 'PartiallyShipped', 'Shipped', 'InvoiceUnconfirmed', 'Canceled', 'Unfulfillable'],
    required: true,
  },
  fulfillmentChannel: {
    type: String,
    enum: ['AFN', 'MFN'],
  },
  salesChannel: String,
  orderChannel: String,
  shipServiceLevel: String,
  shipmentServiceLevelCategory: String,
  orderTotal: {
    amount: Number,
    currencyCode: String,
  },
  numberOfItemsShipped: Number,
  numberOfItemsUnshipped: Number,
  paymentExecutionDetail: [{
    payment: {
      amount: Number,
      currencyCode: String,
    },
    paymentMethod: String,
  }],
  paymentMethod: String,
  paymentMethodDetails: {
    paymentMethodDetail: String,
    paymentMethod: String,
  },
  marketplaceId: String,
  marketplaceName: String,
  buyerEmail: String,
  buyerName: String,
  buyerCounty: String,
  buyerTaxInfo: {
    companyLegalName: String,
    taxingRegion: String,
    taxClassifications: [{
      name: String,
      value: String,
    }],
  },
  shippingAddress: {
    name: String,
    addressLine1: String,
    addressLine2: String,
    addressLine3: String,
    city: String,
    county: String,
    district: String,
    stateOrRegion: String,
    municipality: String,
    postalCode: String,
    countryCode: String,
    phone: String,
    addressType: String,
  },
  orderItems: [orderItemSchema],
  isBusinessOrder: Boolean, // Is Business Order
  isPrime: Boolean,
  isPremiumOrder: Boolean,
  isGlobalExpressEnabled: Boolean,
  isSoldByAB: Boolean,
  isIBA: Boolean,
  isReplacementOrder: Boolean, // Is Replacement Order
  replacedOrderId: String,
  hasCustomerReturn: {
    type: Boolean,
    default: false,
    index: true,
  },
  /** Max return-date across customerReturns — used to filter/sort the Returned tab. */
  latestCustomerReturnDate: {
    type: Date,
    index: true,
  },
  customerReturns: [{
    returnDate: Date,
    sku: String,
    asin: String,
    fnsku: String,
    productName: String,
    quantity: Number,
    fulfillmentCenterId: String,
    disposition: String,
    reason: String,
    status: String,
  }],
  /**
   * Refunds from the Finances API (RefundEventList). Distinct from customerReturns:
   * Amazon issues refunds for returnless refunds/concessions and often before the
   * physical unit is received, so the FBA Customer Returns report misses them.
   * Tracking both lets the Returned tab match Seller Central's refund view.
   */
  hasRefund: {
    type: Boolean,
    default: false,
    index: true,
  },
  latestRefundDate: {
    type: Date,
    index: true,
  },
  refunds: [{
    refundDate: Date,
    sku: String,
    asin: String,
    productName: String,
    quantity: Number,
    amount: Number,
    currency: String,
    marketplaceName: String,
    // listTransactions vs Finances v0; DEFERRED refunds only appear on the former
    source: String,
    transactionStatus: String,
    refundId: String,
  }],
  /**
   * max(latestCustomerReturnDate, latestRefundDate) — used to sort the Returned
   * tab so refund-only orders (no FBA return row yet) aren't buried by null
   * latestCustomerReturnDate.
   */
  latestReturnedActivityDate: {
    type: Date,
    index: true,
  },
  promiseResponseDueDate: Date,
  isEstimatedShipDateSet: Boolean,
  isSoldBySeller: Boolean,
  defaultShipFromLocationAddress: {
    name: String,
    addressLine1: String,
    city: String,
    stateOrRegion: String,
    postalCode: String,
    countryCode: String,
  },
  notes: [{
    text: String,
    type: {
      type: String,
      enum: ['general', 'shipping', 'refund', 'complaint', 'internal'],
      default: 'general',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  }],
  lastSynced: {
    type: Date,
    default: Date.now,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Index for efficient queries
orderSchema.index({ sellerId: 1, purchaseDate: -1 });
orderSchema.index({ sellerId: 1, orderStatus: 1 });
orderSchema.index({ sellerId: 1, hasCustomerReturn: 1 });
orderSchema.index({ sellerId: 1, latestCustomerReturnDate: -1 });
orderSchema.index({ sellerId: 1, 'customerReturns.returnDate': -1 });
orderSchema.index({ sellerId: 1, hasRefund: 1 });
orderSchema.index({ sellerId: 1, latestRefundDate: -1 });
orderSchema.index({ sellerId: 1, latestReturnedActivityDate: -1 });
orderSchema.index({ sellerId: 1, amazonOrderId: 1 }, { unique: true });

// Update updatedAt on save
orderSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Order', orderSchema);
