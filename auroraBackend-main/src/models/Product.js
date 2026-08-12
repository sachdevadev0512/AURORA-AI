const mongoose = require('mongoose');

const moneySchema = {
  amount: { type: Number, default: 0 },
  currency: { type: String, default: 'USD' },
};

const productSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  asin: {
    type: String,
    required: true,
    index: true,
  },
  sku: {
    type: String,
    required: true,
  },
  fnSku: {
    type: String,
    default: null,
  },
  ean: {
    type: String,
    default: null,
  },
  title: {
    type: String,
    required: true,
  },
  price: moneySchema,
  shippingCost: moneySchema,
  minimumPrice: moneySchema,
  maximumPrice: moneySchema,
  businessPrice: moneySchema,
  lowestPrice: moneySchema,
  featuredOffer: {
    isBuyBox: { type: Boolean, default: false },
    price: moneySchema,
  },
  fees: {
    totalFees: moneySchema,
    referralFee: moneySchema,
    fbaFee: moneySchema,
    breakdown: [{
      feeType: String,
      amount: Number,
      currency: String,
    }],
  },
  inventory: {
    quantity: Number,
    totalQuantity: Number,
    fulfillableQuantity: Number,
    reservedQuantity: Number,
    inboundQuantity: Number,
    unfulfillableQuantity: Number,
    inboundWorkingQuantity: Number,
    inboundShippedQuantity: Number,
    inboundReceivingQuantity: Number,
    reservedPendingCustomerOrder: Number,
    reservedPendingTransshipment: Number,
    reservedFcProcessing: Number,
    unfulfillableCustomerDamaged: Number,
    unfulfillableWarehouseDamaged: Number,
    unfulfillableDistributorDamaged: Number,
    unfulfillableCarrierDamaged: Number,
    unfulfillableDefective: Number,
    unfulfillableExpired: Number,
    fulfillmentChannel: {
      type: String,
      enum: ['DEFAULT', 'AFN', 'MFN', 'AMAZON_NA', 'AMAZON_EU'],
      default: 'DEFAULT',
    },
  },
  fulfillmentType: {
    type: String,
    enum: ['FBA', 'FBM', 'UNKNOWN'],
    default: 'UNKNOWN',
  },
  images: [{
    url: String,
    height: Number,
    width: Number,
  }],
  category: String,
  brand: String,
  condition: {
    type: String,
    default: 'New',
  },
  listingStatus: {
    type: String,
    default: null,
  },
  isListedOnAmazon: {
    type: Boolean,
    default: null,
  },
  status: {
    type: String,
    enum: ['Active', 'Inactive', 'Incomplete', 'Closed', 'Out of Stock'],
    default: 'Active',
  },
  salesRank: {
    rank: Number,
    title: String,
    classificationId: String,
  },
  unitsSold: {
    type: Number,
    default: null,
  },
  pageViews: {
    type: Number,
    default: null,
  },
  listingCreatedDate: {
    type: Date,
    default: null,
  },
  lastSynced: {
    type: Date,
    default: Date.now,
  },
  /** When set, inventory sync preserves manual quantity / fulfillable fields. */
  inventoryManualOverrideAt: {
    type: Date,
    default: null,
  },
  feesLastSynced: {
    type: Date,
    default: null,
  },
  // Competitive repricer (Aurora-managed floor/ceiling + strategy)
  repricer: {
    enabled: { type: Boolean, default: false, index: true },
    strategy: {
      type: String,
      enum: ['MATCH_BUY_BOX', 'MATCH_LOWEST', 'BEAT_BUY_BOX', 'BEAT_LOWEST'],
      default: 'MATCH_LOWEST',
    },
    pricingMode: {
      type: String,
      enum: ['PROFIT_FIRST', 'BUY_BOX_FIRST', 'SALES_GROWTH', 'CLEARANCE'],
      default: 'PROFIT_FIRST',
    },
    speedMode: {
      type: String,
      enum: ['AGGRESSIVE', 'BALANCED', 'CONSERVATIVE'],
      default: 'CONSERVATIVE',
    },
    minPrice: { type: Number, default: null },
    maxPrice: { type: Number, default: null },
    currency: { type: String, default: 'USD' },
    beatByAmount: { type: Number, default: 0.01 },
    cooldownMinutes: { type: Number, default: 30 },
    maxChangePercent: { type: Number, default: 15 },
    // Profit / ROI protection
    unitCost: { type: Number, default: null },
    inboundShipping: { type: Number, default: null },
    targetProfit: { type: Number, default: null },
    minRoiPercent: { type: Number, default: null },
    // Competitor filters
    fbaOnly: { type: Boolean, default: false },
    excludeAmazon: { type: Boolean, default: false },
    minFeedbackPercent: { type: Number, default: null },
    minFeedbackCount: { type: Number, default: null },
    // When no valid competitors remain, raise price toward max
    raiseWhenAlonePercent: { type: Number, default: 0 },
    autoDisable: { type: Boolean, default: true },
    dryRun: { type: Boolean, default: false },
    lastRunAt: { type: Date, default: null },
    lastChangeAt: { type: Date, default: null },
    lastCompetitorPrice: { type: Number, default: null },
    lastTargetPrice: { type: Number, default: null },
    lastAction: { type: String, default: null },
    lastError: { type: String, default: null },
    hadBuyBox: { type: Boolean, default: null },
    /** Tracks whether Amazon retail was seen on a prior run (for smart alerts). */
    lastSawAmazonRetail: { type: Boolean, default: false },
  },
  lastUpdatedTime: {
    type: Date,
    default: null,
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

productSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

function touchUpdatedAtHook(next) {
  const update = this.getUpdate() || {};
  if (!update.$set) update.$set = {};
  update.$set.updatedAt = new Date();
  this.setUpdate(update);
  next();
}

productSchema.pre('findOneAndUpdate', touchUpdatedAtHook);
productSchema.pre('updateOne', touchUpdatedAtHook);
productSchema.pre('updateMany', touchUpdatedAtHook);

productSchema.index({ sellerId: 1, sku: 1 }, { unique: true });
productSchema.index({ sellerId: 1, asin: 1 });
productSchema.index({ sellerId: 1, feesLastSynced: 1, updatedAt: -1 });
productSchema.index({ sellerId: 1, 'repricer.enabled': 1, 'repricer.lastRunAt': 1 });

const Product = mongoose.model('Product', productSchema);

async function ensureProductIndexes() {
  const collection = Product.collection;
  const indexes = await collection.indexes();
  const staleUniqueAsin = indexes.find(
    (idx) => idx.name === 'sellerId_1_asin_1' && idx.unique
  );
  if (staleUniqueAsin) {
    await collection.dropIndex('sellerId_1_asin_1');
    console.log('[Product] Dropped legacy unique index sellerId_1_asin_1');
  }

  const forceSync = process.env.SYNC_INDEXES_ON_STARTUP === 'true';
  const { toDrop, toCreate } = await Product.diffIndexes();
  const hasDrift = toDrop.length > 0 || toCreate.length > 0;

  if (!forceSync && !hasDrift) {
    console.log('[Product] Indexes up to date; skipping syncIndexes on startup');
    return;
  }

  if (hasDrift) {
    console.log('[Product] Index drift detected; running syncIndexes', {
      toDrop,
      toCreate: toCreate.map((spec) => spec.name || spec.key),
    });
  } else if (forceSync) {
    console.log('[Product] SYNC_INDEXES_ON_STARTUP=true; running syncIndexes');
  }

  await Product.syncIndexes();
}

module.exports = Product;
module.exports.ensureProductIndexes = ensureProductIndexes;
