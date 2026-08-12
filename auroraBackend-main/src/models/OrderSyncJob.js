const mongoose = require('mongoose');

const checkpointSchema = new mongoose.Schema(
  {
    currentChunkStart: { type: Date, default: null },
    currentChunkEnd: { type: Date, default: null },
    nextToken: { type: String, default: null },
  },
  { _id: false }
);

const orderSyncJobSchema = new mongoose.Schema({
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
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  checkpoint: { type: checkpointSchema, default: () => ({}) },
  processed: { type: Number, default: 0 },
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

orderSyncJobSchema.index({ sellerId: 1, status: 1 });
orderSyncJobSchema.index({ status: 1, updatedAt: 1 });
orderSyncJobSchema.index(
  { sellerId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'RUNNING', stopRequested: false },
  },
);

module.exports = mongoose.model('OrderSyncJob', orderSyncJobSchema);
