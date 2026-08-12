const mongoose = require('mongoose');

const adMetricsDailySchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
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
  date: {
    type: String,
    required: true,
    index: true,
  },
  campaignType: {
    type: String,
    enum: ['Sponsored Products', 'Sponsored Brands', 'Sponsored Display'],
    required: true,
  },
  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  orders: { type: Number, default: 0 },
  spend: { type: Number, default: 0 },
  sales: { type: Number, default: 0 },
  currencyCode: { type: String, default: 'USD' },
  source: {
    type: String,
    enum: ['DAILY', 'SUMMARY'],
    default: 'DAILY',
  },
  lastSynced: {
    type: Date,
    default: Date.now,
  },
});

adMetricsDailySchema.index(
  { sellerId: 1, profileId: 1, campaignId: 1, date: 1 },
  { unique: true },
);
adMetricsDailySchema.index({ sellerId: 1, date: 1 });

module.exports = mongoose.model('AdMetricsDaily', adMetricsDailySchema);
