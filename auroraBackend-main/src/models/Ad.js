const mongoose = require('mongoose');

const adSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  profileId: {
    type: String,
    required: true,
    index: true,
  },
  campaignId: {
    type: String,
    required: true,
    index: true,
  },
  campaignName: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ['Active', 'Paused', 'Archived'],
    required: true,
  },
  country: String, // Marketplace
  campaignType: {
    type: String,
    enum: ['Sponsored Products', 'Sponsored Brands', 'Sponsored Display'],
    required: true,
  },
  portfolio: String, // Portfolio Group
  startDate: Date,
  endDate: Date,
  budget: {
    amount: Number,
    currencyCode: String,
  },
  spend: {
    type: {
      amount: { type: Number, default: 0 },
      currencyCode: { type: String, default: 'USD' },
    },
    default: () => ({ amount: 0, currencyCode: 'USD' }),
    minimize: false,
  },
  cpc: Number, // Cost per Click
  impressions: Number,
  clicks: Number,
  ctr: Number, // Click Through Rate
  detailPageViews: Number,
  clickShare: Number,
  orders: Number,
  sales: {
    type: {
      amount: { type: Number, default: 0 },
      currencyCode: { type: String, default: 'USD' },
    },
    default: () => ({ amount: 0, currencyCode: 'USD' }),
    minimize: false,
  },
  conversionRate: Number, // CVR
  unitsSold: Number,
  acos: Number, // Advertising Cost of Sale
  roas: Number, // Return on Ad Spend
  tacos: Number, // TACOS
  profitMarginImpact: Number,
  brandedSearches: Number,
  newToBrandOrders: Number,
  searchTermCoverage: [String], // Keywords/search terms
  metricsStartDate: Date,
  metricsEndDate: Date,
  lifetimeImpressions: { type: Number, default: 0 },
  lifetimeClicks: { type: Number, default: 0 },
  lifetimeOrders: { type: Number, default: 0 },
  lifetimeCtr: { type: Number, default: 0 },
  lifetimeCpc: { type: Number, default: 0 },
  lifetimeAcos: { type: Number, default: 0 },
  lifetimeRoas: { type: Number, default: 0 },
  lifetimeSpend: {
    type: {
      amount: { type: Number, default: 0 },
      currencyCode: { type: String, default: 'USD' },
    },
    default: () => ({ amount: 0, currencyCode: 'USD' }),
    minimize: false,
  },
  lifetimeSales: {
    type: {
      amount: { type: Number, default: 0 },
      currencyCode: { type: String, default: 'USD' },
    },
    default: () => ({ amount: 0, currencyCode: 'USD' }),
    minimize: false,
  },
  lifetimeSyncedAt: Date,
  lifetimeSource: {
    type: String,
    enum: ['api', 'seller_central'],
    default: 'api',
  },
  lifetimeImportedAt: Date,
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

// Indexes
adSchema.index({ sellerId: 1, status: 1 });
adSchema.index({ sellerId: 1, campaignType: 1 });
adSchema.index({ sellerId: 1, startDate: -1 });
adSchema.index({ sellerId: 1, profileId: 1, campaignId: 1 }, { unique: true });

// Update updatedAt on save
adSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Ad', adSchema);
