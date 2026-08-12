const mongoose = require('mongoose');

const repricerLogSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
    index: true,
  },
  sku: { type: String, required: true },
  asin: { type: String, default: null },
  strategy: { type: String, default: null },
  previousPrice: { type: Number, default: null },
  competitorPrice: { type: Number, default: null },
  targetPrice: { type: Number, default: null },
  appliedPrice: { type: Number, default: null },
  minPrice: { type: Number, default: null },
  maxPrice: { type: Number, default: null },
  action: {
    type: String,
    enum: ['updated', 'skipped', 'clamped', 'dry_run', 'error'],
    required: true,
  },
  reason: { type: String, default: null },
  dryRun: { type: Boolean, default: false },
  source: { type: String, default: 'manual' },
  createdAt: { type: Date, default: Date.now, index: true },
});

repricerLogSchema.index({ sellerId: 1, createdAt: -1 });
repricerLogSchema.index({ productId: 1, createdAt: -1 });

module.exports = mongoose.model('RepricerLog', repricerLogSchema);
