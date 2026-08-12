const User = require('../models/User');
const Shipment = require('../models/Shipment');
const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const {
  buildInboundPlanIndex,
  refreshShipmentTracking,
} = require('./shipmentTrackingService');

const INTERVAL_MS = Math.max(
  60000,
  parseInt(process.env.SHIPMENT_LIVE_TRACKING_INTERVAL_MS || '180000', 10)
);
const BATCH_SIZE = Math.max(5, parseInt(process.env.SHIPMENT_LIVE_TRACKING_BATCH_SIZE || '20', 10));
const STALE_MS = Math.max(
  60000,
  parseInt(process.env.SHIPMENT_LIVE_TRACKING_STALE_MS || '120000', 10)
);

const ACTIVE_STATUSES = ['WORKING', 'CREATED', 'CHECKED_IN', 'SHIPPED', 'IN_TRANSIT', 'RECEIVING', 'DELIVERED'];

class ShipmentLiveTrackingScheduler {
  constructor() {
    this.timer = null;
    this.running = false;
    this.registeredUsers = new Set();
  }

  registerUser(userId) {
    if (userId) this.registeredUsers.add(String(userId));
  }

  async startAll() {
    if (this.timer) return;
    const users = await User.find({
      amazonRefreshToken: { $exists: true, $ne: null },
    })
      .select('_id')
      .lean();

    for (const user of users) {
      this.registeredUsers.add(String(user._id));
    }

    console.log(
      `[ShipmentLiveTracking] Started (interval ${INTERVAL_MS}ms, batch ${BATCH_SIZE})`
    );
    this.timer = setInterval(() => {
      void this.runCycle();
    }, INTERVAL_MS);

    setTimeout(() => void this.runCycle(), 15000);
  }

  async runCycle() {
    if (this.running) return;
    this.running = true;

    try {
      const userIds = [...this.registeredUsers];
      for (const userId of userIds) {
        try {
          await this.trackUserShipments(userId);
        } catch (err) {
          console.warn(`[ShipmentLiveTracking] User ${userId}:`, err.message);
        }
      }
    } finally {
      this.running = false;
    }
  }

  async trackUserShipments(userId) {
    const user = await User.findById(userId);
    if (!user?.amazonRefreshToken) {
      this.registeredUsers.delete(String(userId));
      return;
    }

    const staleBefore = new Date(Date.now() - STALE_MS);
    const shipments = await Shipment.find({
      sellerId: userId,
      isLiveTracking: true,
      status: { $in: ACTIVE_STATUSES },
      $or: [{ lastTrackedAt: null }, { lastTrackedAt: { $lt: staleBefore } }],
    })
      .sort({ lastTrackedAt: 1, lastUpdatedDate: -1 })
      .limit(BATCH_SIZE);

    if (!shipments.length) return;

    const sellerAppCredentials = await getSellerAppCredentials(user);
    const amazonAPI = new AmazonAPI(user, sellerAppCredentials);
    const planIndex = await buildInboundPlanIndex(amazonAPI);

    for (const shipment of shipments) {
      try {
        await refreshShipmentTracking(user, shipment, amazonAPI, { planIndex });
      } catch (err) {
        console.warn(
          `[ShipmentLiveTracking] ${shipment.shipmentType} ${shipment.shipmentId}:`,
          err.message
        );
      }
    }

    try {
      const { checkDelayedShipmentsForUser } = require('./shipmentDelayService');
      await checkDelayedShipmentsForUser(userId);
    } catch (delayErr) {
      console.warn(`[ShipmentLiveTracking] Delay scan for ${userId}:`, delayErr.message);
    }
  }
}

const shipmentLiveTrackingScheduler = new ShipmentLiveTrackingScheduler();

async function ensureShipmentLiveTrackingForUser(userId) {
  shipmentLiveTrackingScheduler.registerUser(userId);
}

module.exports = {
  shipmentLiveTrackingScheduler,
  ensureShipmentLiveTrackingForUser,
};
