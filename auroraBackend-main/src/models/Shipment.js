const mongoose = require('mongoose');

const shipmentSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  shipmentType: {
    type: String,
    enum: ['fba_fc', 'awd_dc'],
    required: true,
    index: true,
  },
  shipmentId: {
    type: String,
    required: true,
    index: true,
  },
  referenceId: {
    type: String,
    default: null,
  },
  // FBA shipment display name, e.g. "FBA STA (06/30/2026 06:13)-HIA1"
  shipmentName: {
    type: String,
    default: null,
  },
  orderId: {
    type: String,
    default: null,
  },
  createdDate: {
    type: Date,
    default: null,
  },
  lastUpdatedDate: {
    type: Date,
    default: null,
    index: true,
  },
  shipDate: {
    type: Date,
    default: null,
  },
  skuCount: {
    type: Number,
    default: 0,
  },
  unitsExpected: {
    type: Number,
    default: null,
  },
  unitsLocated: {
    type: Number,
    default: null,
  },
  boxesExpected: {
    type: Number,
    default: null,
  },
  boxesReceived: {
    type: Number,
    default: null,
  },
  status: {
    type: String,
    required: true,
    index: true,
  },
  displayStatus: {
    type: String,
    required: true,
  },
  trackingId: {
    type: String,
    default: null,
  },
  trackingUrl: {
    type: String,
    default: null,
  },
  destinationCenterId: {
    type: String,
    default: null,
  },
  inboundPlanId: {
    type: String,
    default: null,
  },
  carrierName: {
    type: String,
    default: null,
  },
  estimatedDeliveryDate: {
    type: Date,
    default: null,
  },
  isDelayed: {
    type: Boolean,
    default: false,
    index: true,
  },
  delayNotifiedAt: {
    type: Date,
    default: null,
  },
  trackingPackages: [{
    boxId: { type: String, default: null },
    trackingId: { type: String, default: null },
    carrierName: { type: String, default: null },
    packageStatus: { type: String, default: null },
    trackingUrl: { type: String, default: null },
  }],
  lineItems: [{
    sku: { type: String, default: null },
    fnsku: { type: String, default: null },
    unitsExpected: { type: Number, default: 0 },
    unitsReceived: { type: Number, default: 0 },
    variance: { type: Number, default: 0 },
  }],
  hasDiscrepancy: {
    type: Boolean,
    default: false,
    index: true,
  },
  statusTimeline: [{
    status: { type: String, required: true },
    displayStatus: { type: String, required: true },
    at: { type: Date, required: true },
  }],
  lastTrackedAt: {
    type: Date,
    default: null,
    index: true,
  },
  isLiveTracking: {
    type: Boolean,
    default: false,
    index: true,
  },
  lastSynced: {
    type: Date,
    default: Date.now,
  },
  detailsEnrichedAt: {
    type: Date,
    default: null,
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
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

shipmentSchema.pre('save', function saveHook(next) {
  this.updatedAt = Date.now();
  next();
});

shipmentSchema.index({ sellerId: 1, shipmentType: 1, shipmentId: 1 }, { unique: true });
shipmentSchema.index({ sellerId: 1, lastUpdatedDate: -1 });
shipmentSchema.index({ sellerId: 1, status: 1, lastUpdatedDate: -1 });
shipmentSchema.index({ sellerId: 1, isLiveTracking: 1, lastTrackedAt: 1 });
shipmentSchema.index({ sellerId: 1, isDelayed: 1, estimatedDeliveryDate: 1 });

module.exports = mongoose.model('Shipment', shipmentSchema);
