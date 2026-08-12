const mongoose = require('mongoose');

const appNotificationSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  source: {
    type: String,
    enum: ['amazon', 'aurora'],
    default: 'aurora',
    index: true,
  },
  type: {
    type: String,
    enum: [
      'order_change',
      'amazon_order',
      'amazon_orders_batch',
      'amazon_live_enabled',
      'orders_sync',
      'ads_sync',
      'ads_sync_error',
      'product_fee_change',
      'inventory_sync',
      'shipment_delayed',
      'info',
    ],
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  message: {
    type: String,
    required: true,
  },
  link: {
    type: String,
    default: null,
  },
  read: {
    type: Boolean,
    default: false,
    index: true,
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

appNotificationSchema.index({ sellerId: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model('AppNotification', appNotificationSchema);
