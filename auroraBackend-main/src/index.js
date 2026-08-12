const dotenv = require('dotenv');

dotenv.config();

const { registerProcessHandlers } = require('./config/processHandlers');
registerProcessHandlers();

const connectDB = require('./config/database');
const { validateRequiredEnv } = require('./config/validateEnv');
validateRequiredEnv();

try {
  const { applyLocalSqsToEnv } = require('./utils/sqsLocalConfig');
  applyLocalSqsToEnv();
} catch (e) {
  console.warn('[App] SQS local config load skipped:', e.message);
}

const { createApp } = require('./app');

async function runStartupWorkers() {
  try {
    const User = require('./models/User');
    const { purgeAdsIfMisaligned } = require('./utils/adsAccessGuard');
    const usersWithAds = await User.find({
      amazonAdsRefreshToken: { $exists: true, $ne: null },
    }).select('_id email');

    for (const u of usersWithAds) {
      const { purged } = await purgeAdsIfMisaligned(u._id);
      if (purged > 0) {
        console.warn(`[Ads] Startup purge: removed ${purged} misaligned campaign(s) for ${u.email || u._id}`);
      }
    }
  } catch (purgeErr) {
    console.error('[Ads] Startup misaligned ads purge failed:', purgeErr.message);
  }

  if (process.env.ADS_LIVE_SYNC_ENABLED !== 'false') {
    try {
      const { adsLiveSyncScheduler } = require('./services/adsSyncService');
      await adsLiveSyncScheduler.startAll();
    } catch (err) {
      console.error('[AdsLiveSync] Failed to start background sync:', err.message);
    }
  } else {
    console.log('[AdsLiveSync] Background sync disabled (ADS_LIVE_SYNC_ENABLED=false)');
  }

  try {
    const { startAdsReportQueuePoller } = require('./services/adsReportQueueService');
    startAdsReportQueuePoller();
  } catch (err) {
    console.error('[AdsReportQueue] Failed to start report poller:', err.message);
  }

  try {
    const { ensureProductIndexes } = require('./models/Product');
    await ensureProductIndexes();
  } catch (err) {
    console.error('[Product] Index migration failed:', err.message);
  }

  try {
    const { resumeInterruptedInventorySyncJobs } = require('./services/inventorySyncService');
    await resumeInterruptedInventorySyncJobs();
  } catch (err) {
    console.error('[InventorySync] Failed to resume interrupted jobs:', err.message);
  }

  try {
    const { resumeInterruptedOrderSyncJobs } = require('./services/orderSyncService');
    await resumeInterruptedOrderSyncJobs();
  } catch (err) {
    console.error('[OrderSync] Failed to resume interrupted jobs:', err.message);
  }

  if (process.env.ORDER_NOTIFICATIONS_ENABLED !== 'false') {
    try {
      const notificationService = require('./services/notificationService');
      const sqsNotificationPoller = require('./services/sqsNotificationPoller');

      await notificationService.bootstrap();

      const resubscribeOnStartup =
        process.env.ORDER_NOTIFICATIONS_RESUBSCRIBE_ON_STARTUP === 'true' ||
        process.env.ORDER_NOTIFICATIONS_RESUBSCRIBE_ON_STARTUP === '1';

      if (resubscribeOnStartup && process.env.AWS_SQS_QUEUE_ARN) {
        await notificationService.resubscribeAllConnectedUsers();
      }

      sqsNotificationPoller.start();

      // When SQS polling can't run (e.g. AWS credentials not configured),
      // fall back to periodic SP-API delta syncs so per-order bell
      // notifications keep flowing.
      if (!sqsNotificationPoller.getPollerConfig().running) {
        const { orderDeltaSyncScheduler } = require('./services/orderDeltaSyncService');
        await orderDeltaSyncScheduler.startAll();
      }
    } catch (err) {
      console.error('[OrderNotifications] Failed to start:', err.message);
    }
  } else {
    console.log('[OrderNotifications] Disabled (ORDER_NOTIFICATIONS_ENABLED=false)');
  }

  if (process.env.PRODUCT_FEE_LIVE_SYNC_ENABLED !== 'false') {
    try {
      const { productFeeLiveSyncScheduler } = require('./services/productFeeLiveSync');
      await productFeeLiveSyncScheduler.startAll();
    } catch (err) {
      console.error('[ProductFeeLiveSync] Failed to start:', err.message);
    }
  } else {
    console.log('[ProductFeeLiveSync] Disabled (PRODUCT_FEE_LIVE_SYNC_ENABLED=false)');
  }

  if (process.env.INVENTORY_QTY_LIVE_SYNC_ENABLED !== 'false') {
    try {
      const {
        inventoryQuantityLiveSyncScheduler,
      } = require('./services/inventoryQuantityLiveSync');
      await inventoryQuantityLiveSyncScheduler.startAll();
    } catch (err) {
      console.error('[InventoryQtyLiveSync] Failed to start:', err.message);
    }
  } else {
    console.log('[InventoryQtyLiveSync] Disabled (INVENTORY_QTY_LIVE_SYNC_ENABLED=false)');
  }

  if (process.env.CUSTOMER_REFUNDS_LIVE_SYNC_ENABLED !== 'false') {
    try {
      const {
        customerRefundsLiveSyncScheduler,
      } = require('./services/customerRefundsLiveSync');
      await customerRefundsLiveSyncScheduler.startAll();
    } catch (err) {
      console.error('[CustomerRefundsLiveSync] Failed to start:', err.message);
    }
  } else {
    console.log('[CustomerRefundsLiveSync] Disabled (CUSTOMER_REFUNDS_LIVE_SYNC_ENABLED=false)');
  }

  if (process.env.REPRICER_LIVE_SYNC_ENABLED !== 'false') {
    try {
      const { repricerLiveSyncScheduler } = require('./services/repricerLiveSync');
      await repricerLiveSyncScheduler.startAll();
    } catch (err) {
      console.error('[Repricer] Failed to start:', err.message);
    }
  } else {
    console.log('[Repricer] Disabled (REPRICER_LIVE_SYNC_ENABLED=false)');
  }

  if (process.env.SHIPMENT_LIVE_TRACKING_ENABLED !== 'false') {
    try {
      const { shipmentSyncManager } = require('./services/shipmentSyncService');
      await shipmentSyncManager.recoverJobsOnStartup();

      const { shipmentLiveTrackingScheduler } = require('./services/shipmentLiveTracking');
      await shipmentLiveTrackingScheduler.startAll();
    } catch (err) {
      console.error('[ShipmentLiveTracking] Failed to start:', err.message);
    }
  } else {
    console.log('[ShipmentLiveTracking] Disabled (SHIPMENT_LIVE_TRACKING_ENABLED=false)');
    try {
      const { shipmentSyncManager } = require('./services/shipmentSyncService');
      await shipmentSyncManager.recoverJobsOnStartup();
    } catch (err) {
      console.error('[ShipmentSync] Failed to recover jobs:', err.message);
    }
  }
}

async function startServer() {
  await connectDB();

  const { app, server } = await createApp();
  const PORT = process.env.PORT || 5000;

  server.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await runStartupWorkers();
  });

  return app;
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
