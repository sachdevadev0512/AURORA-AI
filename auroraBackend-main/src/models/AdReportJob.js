const mongoose = require('mongoose');

const adReportJobSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  batchId: {
    type: String,
    required: true,
    index: true,
  },
  profileId: {
    type: String,
    required: true,
  },
  campaignType: {
    type: String,
    required: true,
  },
  reportId: {
    type: String,
    required: true,
    unique: true,
  },
  apiVersion: {
    type: String,
    enum: ['v3', 'v1'],
    default: 'v3',
  },
  adsAccountId: String,
  startDate: String,
  endDate: String,
  batchMetricsStart: String,
  batchMetricsEnd: String,
  timeUnit: {
    type: String,
    enum: ['DAILY', 'SUMMARY'],
    default: 'DAILY',
  },
  isCustomRange: {
    type: Boolean,
    default: false,
  },
  metricsResetDone: {
    type: Boolean,
    default: false,
  },
  status: {
    type: String,
    enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'],
    default: 'PENDING',
  },
  error: String,
  processingStartedAt: Date,
  createdAt: {
    type: Date,
    default: Date.now,
  },
  completedAt: Date,
});

adReportJobSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('AdReportJob', adReportJobSchema);
