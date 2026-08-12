const mongoose = require('mongoose');

const shipmentSyncJobSchema = new mongoose.Schema({
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
  phase: { type: String, default: 'starting' },
  processed: { type: Number, default: 0 },
  saved: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  message: { type: String, default: null },
  error: { type: String, default: null },
  startedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
});

shipmentSyncJobSchema.index({ sellerId: 1, status: 1 });

module.exports = mongoose.model('ShipmentSyncJob', shipmentSyncJobSchema);
