const User = require('../models/User');
const Product = require('../models/Product');
const { refreshProductFeesAndNotify } = require('./productFeeNotificationService');

const ENABLED = process.env.PRODUCT_FEE_LIVE_SYNC_ENABLED !== 'false';
const INTERVAL_MS = Math.max(
  60 * 1000,
  parseInt(process.env.PRODUCT_FEE_LIVE_SYNC_INTERVAL_MS || '120000', 10)
);
const BATCH_SIZE = Math.max(
  5,
  parseInt(process.env.PRODUCT_FEE_LIVE_SYNC_BATCH_SIZE || '40', 10)
);
const DELAY_MS = Math.max(
  200,
  parseInt(process.env.PRODUCT_FEE_LIVE_SYNC_DELAY_MS || '350', 10)
);
const RECONCILE_MS = Math.max(
  60 * 1000,
  parseInt(process.env.PRODUCT_FEE_LIVE_SYNC_RECONCILE_MS || '120000', 10)
);

const { sleep } = require('../utils/async');
const { emitToUser } = require('../utils/socketEmit');
const {
  createPerUserSchedulerState,
  registerUserInterval,
  unregisterUserInterval,
  reconcileUserTimers,
  startReconcileLoop,
  stopAllUserTimers,
} = require('./sync/perUserScheduler');

class ProductFeeLiveSyncScheduler {
  constructor() {
    Object.assign(this, createPerUserSchedulerState());
    this.activeSyncs = new Map();
    this.lastRunByUser = new Map();
  }

  async runSyncForUser(userId, source = 'live_scheduled') {
    const id = String(userId);

    if (this.activeSyncs.has(id)) {
      return this.activeSyncs.get(id);
    }

    const syncPromise = (async () => {
      const user = await User.findById(id);
      if (!user?.amazonRefreshToken) {
        return { skipped: true, reason: 'amazon_not_connected' };
      }

      const products = await Product.find({
        sellerId: user._id,
        asin: { $exists: true, $ne: null },
        sku: { $exists: true, $ne: '' },
      })
        .sort({ feesLastSynced: 1, updatedAt: -1 })
        .limit(BATCH_SIZE);

      if (products.length === 0) {
        return { checked: 0, changes: 0, notified: 0 };
      }

      let checked = 0;
      let changes = 0;
      let notified = 0;

      emitToUser(id, 'productFeeLiveSyncStatus', {
        event: 'PRODUCT_FEE_LIVE_SYNC_STARTED',
        source,
        checking: products.length,
        message: `Checking fees for ${products.length} product(s)…`,
      });

      for (const product of products) {
        const result = await refreshProductFeesAndNotify(user, product, { notify: true });
        checked += 1;
        changes += result.changes?.length || 0;
        notified += result.notified || 0;
        await sleep(DELAY_MS);
      }

      const summary = { checked, changes, notified, source };
      this.lastRunByUser.set(id, { ...summary, at: new Date().toISOString() });

      emitToUser(id, 'productFeeLiveSyncStatus', {
        event: 'PRODUCT_FEE_LIVE_SYNC_COMPLETE',
        ...summary,
        message:
          changes > 0
            ? `${changes} product fee change(s) detected — ${notified} notification(s) sent`
            : `Fees up to date for ${checked} product(s)`,
      });

      if (changes > 0) {
        console.log(`[ProductFeeLiveSync] User ${id}: ${changes} change(s), ${notified} notified (${source})`);
      }

      return summary;
    })().finally(() => {
      this.activeSyncs.delete(id);
    });

    this.activeSyncs.set(id, syncPromise);
    return syncPromise;
  }

  registerUser(userId) {
    const id = String(userId);
    if (this.userTimers.has(id)) return;

    this.runSyncForUser(id, 'live_initial').catch(() => {});
    registerUserInterval(this, id, INTERVAL_MS, (uid) =>
      this.runSyncForUser(uid, 'live_scheduled'),
    );
    console.log(`[ProductFeeLiveSync] Registered user ${id} (every ${Math.round(INTERVAL_MS / 1000)}s)`);
  }

  unregisterUser(userId) {
    unregisterUserInterval(this, userId);
  }

  async ensureRegisteredForUser(userId) {
    const id = String(userId);
    const user = await User.findById(id).select('amazonRefreshToken');

    if (!user?.amazonRefreshToken) {
      this.unregisterUser(id);
      return { registered: false, reason: 'amazon_not_connected' };
    }

    if (!this.userTimers.has(id)) {
      this.registerUser(id);
    }

    return { registered: true };
  }

  async reconcileUsers() {
    const users = await User.find({
      amazonRefreshToken: { $exists: true, $ne: null },
    }).select('_id');

    const eligible = new Set(users.map((u) => String(u._id)));
    return reconcileUserTimers(
      this,
      eligible,
      (userId) => this.registerUser(userId),
      (userId) => this.unregisterUser(userId),
    );
  }

  async startAll() {
    if (!ENABLED) {
      console.log('[ProductFeeLiveSync] Disabled (PRODUCT_FEE_LIVE_SYNC_ENABLED=false)');
      return;
    }
    if (this.started) return;

    await this.reconcileUsers();
    this.started = true;
    startReconcileLoop(this, RECONCILE_MS, () => this.reconcileUsers(), 'ProductFeeLiveSync');

    console.log(
      `[ProductFeeLiveSync] Live fee sync started — every ${Math.round(INTERVAL_MS / 1000)}s, ` +
        `${BATCH_SIZE} products/cycle (bell + socket on change)`
    );
  }

  stopAll() {
    stopAllUserTimers(this, (userId) => this.unregisterUser(userId));
  }

  getStatus(userId) {
    const id = userId ? String(userId) : null;
    return {
      enabled: ENABLED,
      started: this.started,
      intervalMs: INTERVAL_MS,
      batchSize: BATCH_SIZE,
      registered: id ? this.userTimers.has(id) : undefined,
      lastRun: id ? this.lastRunByUser.get(id) || null : null,
      registeredUsers: this.userTimers.size,
    };
  }
}

const productFeeLiveSyncScheduler = new ProductFeeLiveSyncScheduler();

async function ensureProductFeeLiveSyncForUser(userId) {
  return productFeeLiveSyncScheduler.ensureRegisteredForUser(userId);
}

module.exports = {
  productFeeLiveSyncScheduler,
  ensureProductFeeLiveSyncForUser,
};
