/**
 * Order delta sync — pulls recent orders straight from SP-API (no AWS/SQS needed).
 *
 * Two entry points:
 *  - runOrderDeltaSyncForUser: shared by the manual /notifications/sync endpoint
 *    and the fallback scheduler.
 *  - orderDeltaSyncScheduler: background fallback that keeps per-order bell
 *    notifications flowing when the SQS ORDER_CHANGE poller cannot run
 *    (missing AWS credentials or queue config).
 */

const User = require('../models/User');
const Order = require('../models/Order');
const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const { normalizeOrderForDb } = require('../utils/orderNotificationNormalizer');
const { upsertOrderFromLiveSync } = require('../utils/orderUpdateMerge');
const { loadSellerFeeMap } = require('../utils/orderItemFees');
const {
  createPerUserSchedulerState,
  registerUserInterval,
  unregisterUserInterval,
  reconcileUserTimers,
  startReconcileLoop,
  stopAllUserTimers,
} = require('./sync/perUserScheduler');

// Opt-in: SP-API delta polling costs API quota, so it only runs when explicitly
// enabled. Prefer fixing SQS credentials for real-time push notifications.
const ENABLED = process.env.ORDER_DELTA_SYNC_FALLBACK_ENABLED === 'true';
const INTERVAL_MS = Math.max(
  60 * 1000,
  parseInt(process.env.ORDER_DELTA_SYNC_INTERVAL_MS || '300000', 10)
);
const RECONCILE_MS = Math.max(
  60 * 1000,
  parseInt(process.env.ORDER_DELTA_SYNC_RECONCILE_MS || '300000', 10)
);
const DEFAULT_LOOKBACK_MINUTES = parseInt(
  process.env.ORDER_DELTA_SYNC_LOOKBACK_MINUTES || '30',
  10
);
const BATCH_NOTIFY_THRESHOLD = 5;

/**
 * Pull orders created in the lookback window, upsert them, and publish bell
 * notifications.
 *
 * notifyMode:
 *  - 'all'     — notify for every synced order (manual sync feedback)
 *  - 'changed' — notify only for new orders or status changes (scheduler; avoids
 *                repeating the same order every cycle)
 */
async function runOrderDeltaSyncForUser(
  user,
  { lookbackMinutes = DEFAULT_LOOKBACK_MINUTES, notifyMode = 'all' } = {}
) {
  const sellerAppCredentials = await getSellerAppCredentials(user._id);
  const amazonAPI = new AmazonAPI(user, sellerAppCredentials);

  const createdAfter = new Date(Date.now() - lookbackMinutes * 60 * 1000);
  // SP-API rejects CreatedBefore too close to now.
  const createdBefore = new Date(Date.now() - 2 * 60 * 1000);

  let nextToken = null;
  const fetchedOrders = [];

  do {
    const { orders, nextToken: token } = await amazonAPI.getOrders(
      createdAfter.toISOString(),
      createdBefore.toISOString(),
      nextToken
    );
    nextToken = token;
    for (const order of orders || []) fetchedOrders.push(order);
  } while (nextToken);

  const fetchedIds = fetchedOrders
    .map((order) => order.AmazonOrderId || order.amazonOrderId)
    .filter(Boolean);

  const existingStatuses = new Map();
  if (fetchedIds.length > 0) {
    const existing = await Order.find({
      sellerId: user._id,
      amazonOrderId: { $in: fetchedIds },
    })
      .select('amazonOrderId orderStatus')
      .lean();
    for (const doc of existing) {
      existingStatuses.set(doc.amazonOrderId, doc.orderStatus);
    }
  }

  const syncedOrders = [];
  const changedOrders = [];
  const feeMap = await loadSellerFeeMap(user._id);

  for (const order of fetchedOrders) {
    try {
      const orderId = order.AmazonOrderId || order.amazonOrderId;
      if (!orderId) continue;

      const orderItems = await amazonAPI.getOrderItems(orderId);
      const orderDetails = {
        ...order,
        amazonOrderId: orderId,
        orderItems,
      };
      const orderData = normalizeOrderForDb(user._id, orderDetails, feeMap);
      const savedOrder = await upsertOrderFromLiveSync(Order, user._id, orderData);
      syncedOrders.push(savedOrder);

      const previousStatus = existingStatuses.get(orderId);
      if (previousStatus === undefined || previousStatus !== savedOrder.orderStatus) {
        changedOrders.push(savedOrder);
      }
    } catch (err) {
      console.error('[OrderDeltaSync] Order sync error:', err.message);
    }
  }

  const ordersToNotify = notifyMode === 'changed' ? changedOrders : syncedOrders;

  if (ordersToNotify.length > 0) {
    try {
      const appNotificationService = require('./appNotificationService');

      if (ordersToNotify.length > BATCH_NOTIFY_THRESHOLD) {
        await appNotificationService.publishAmazonOrdersBatch(user._id, {
          count: ordersToNotify.length,
          lookbackMinutes,
        });
      } else {
        for (const savedOrder of ordersToNotify) {
          await appNotificationService.publishAmazonOrderUpdate(user._id, savedOrder, {
            event: 'ORDER_SYNCED',
          });
        }
      }
    } catch (notifyErr) {
      console.warn('[OrderDeltaSync] Inbox notification failed:', notifyErr.message);
    }
  }

  return {
    syncedCount: syncedOrders.length,
    syncedOrders,
    changedCount: changedOrders.length,
    lookbackMinutes,
  };
}

/**
 * Background fallback scheduler. Only polls while the SQS ORDER_CHANGE poller is
 * unavailable; if real-time polling comes back (credentials added + repair), the
 * per-tick guard makes this a no-op.
 */
class OrderDeltaSyncScheduler {
  constructor() {
    Object.assign(this, createPerUserSchedulerState());
    this.activeSyncs = new Map();
  }

  isSqsPollerActive() {
    const sqsNotificationPoller = require('./sqsNotificationPoller');
    return sqsNotificationPoller.getPollerConfig().running;
  }

  async runForUser(userId) {
    const id = String(userId);
    if (this.activeSyncs.has(id)) {
      return this.activeSyncs.get(id);
    }
    if (this.isSqsPollerActive()) {
      return { skipped: true, reason: 'sqs_poller_active' };
    }

    const syncPromise = (async () => {
      const user = await User.findById(id);
      if (!user?.amazonRefreshToken) {
        return { skipped: true, reason: 'amazon_not_connected' };
      }

      // Look back a bit further than the interval so restarts/slow cycles
      // cannot miss orders; change-detection dedupes the overlap.
      const lookbackMinutes = Math.max(
        DEFAULT_LOOKBACK_MINUTES,
        Math.ceil((INTERVAL_MS / 60000) * 2)
      );

      return runOrderDeltaSyncForUser(user, {
        lookbackMinutes,
        notifyMode: 'changed',
      });
    })().finally(() => {
      this.activeSyncs.delete(id);
    });

    this.activeSyncs.set(id, syncPromise);
    return syncPromise;
  }

  registerUser(userId) {
    if (!ENABLED) return;
    const id = String(userId);
    const registered = registerUserInterval(this, id, INTERVAL_MS, (uid) =>
      this.runForUser(uid).catch((error) => {
        console.warn(`[OrderDeltaSync] Scheduled run failed for ${uid}:`, error.message);
      })
    );
    if (!registered) return;

    console.log(`[OrderDeltaSync] Registered user ${id} (every ${INTERVAL_MS / 1000}s)`);
    setTimeout(() => {
      this.runForUser(id).catch(() => {});
    }, 10000);
  }

  unregisterUser(userId) {
    unregisterUserInterval(this, userId);
  }

  async reconcileUsers() {
    const users = await User.find({
      amazonRefreshToken: { $exists: true, $ne: null },
      amazonSellerId: { $exists: true, $ne: null },
      orderNotificationsEnabled: true,
    })
      .select('_id')
      .lean();

    const activeIds = new Set(users.map((user) => String(user._id)));
    return reconcileUserTimers(
      this,
      activeIds,
      (userId) => this.registerUser(userId),
      (userId) => this.unregisterUser(userId)
    );
  }

  async startAll() {
    if (!ENABLED) {
      console.log(
        '[OrderDeltaSync] Fallback off — fix SQS polling for live notifications, or set ORDER_DELTA_SYNC_FALLBACK_ENABLED=true to poll SP-API instead'
      );
      return;
    }
    if (this.started) return;

    if (this.isSqsPollerActive()) {
      console.log('[OrderDeltaSync] SQS poller active — fallback not needed');
      return;
    }

    this.started = true;
    await this.reconcileUsers();
    startReconcileLoop(this, RECONCILE_MS, () => this.reconcileUsers(), 'OrderDeltaSync');
    console.log(
      `[OrderDeltaSync] Fallback polling started — SQS poller is unavailable, checking recent orders every ${INTERVAL_MS / 1000}s per user`
    );
  }

  stopAll() {
    stopAllUserTimers(this, (userId) => this.unregisterUser(userId));
  }
}

const orderDeltaSyncScheduler = new OrderDeltaSyncScheduler();

module.exports = {
  runOrderDeltaSyncForUser,
  orderDeltaSyncScheduler,
  DEFAULT_LOOKBACK_MINUTES,
};
