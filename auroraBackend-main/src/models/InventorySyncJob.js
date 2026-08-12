const mongoose = require('mongoose');

const checkpointSchema = new mongoose.Schema(
  {
    phase: { type: String, default: 'listings' },
    nextToken: { type: String, default: null },
  },
  { _id: false }
);

const inventorySyncJobSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['RUNNING', 'STOPPING', 'COMPLETED', 'STOPPED', 'FAILED'],
    default: 'RUNNING',
    index: true,
  },
  stopRequested: { type: Boolean, default: false },
  stoppedByUser: { type: Boolean, default: false },
  checkpoint: { type: checkpointSchema, default: () => ({}) },
  processed: { type: Number, default: 0 },
  saved: { type: Number, default: 0 },
  skipped: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  totalListings: { type: Number, default: null },
  phase: { type: String, default: 'starting' },
  message: { type: String, default: null },
  error: { type: String, default: null },
  startedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
  lockedBy: { type: String, default: null, index: true },
  lockExpiresAt: { type: Date, default: null, index: true },
  lockGeneration: { type: Number, default: 0 },
});

inventorySyncJobSchema.index({ sellerId: 1, status: 1 });
inventorySyncJobSchema.index({ status: 1, updatedAt: 1 });
inventorySyncJobSchema.index(
  { sellerId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'RUNNING', stopRequested: false },
  },
);

module.exports = mongoose.model('InventorySyncJob', inventorySyncJobSchema);
