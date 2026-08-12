const User = require('../models/User');
const Product = require('../models/Product');
const { repriceProduct } = require('./repricerService');

const ENABLED = process.env.REPRICER_LIVE_SYNC_ENABLED !== 'false';
// Default 60s so AGGRESSIVE rules can react quickly; per-product cooldown still applies.
const INTERVAL_MS = Math.max(
  30 * 1000,
  parseInt(process.env.REPRICER_LIVE_SYNC_INTERVAL_MS || '60000', 10),
);
const BATCH_SIZE = Math.max(1, parseInt(process.env.REPRICER_LIVE_SYNC_BATCH_SIZE || '20', 10));
const DELAY_MS = Math.max(200, parseInt(process.env.REPRICER_LIVE_SYNC_DELAY_MS || '500', 10));
const RECONCILE_MS = Math.max(
  60 * 1000,
  parseInt(process.env.REPRICER_LIVE_SYNC_RECONCILE_MS || '180000', 10),
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

class RepricerLiveSyncScheduler {
  constructor() {
    Object.assign(this, createPerUserSchedulerState());
    this.activeSyncs = new Map();
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
        'repricer.enabled': true,
        asin: { $exists: true, $ne: null },
        sku: { $exists: true, $ne: '' },
      })
        .sort({ 'repricer.lastRunAt': 1, updatedAt: -1 })
        .limit(BATCH_SIZE);

      if (!products.length) {
        return { checked: 0, updated: 0, skipped: 0, errors: 0 };
      }

      let checked = 0;
      let updated = 0;
      let skipped = 0;
      let errors = 0;

      emitToUser(id, 'repricerLiveSyncStatus', {
        event: 'REPRICER_SYNC_STARTED',
        source,
        checking: products.length,
        message: `Repricing ${products.length} product(s)…`,
      });

      for (const product of products) {
        try {
          const result = await repriceProduct(user, product, { source });
          checked += 1;
          if (result?.updated) updated += 1;
          else if (result?.error) errors += 1;
          else skipped += 1;
        } catch (error) {
          errors += 1;
          console.warn(`[Repricer] ${product.sku}:`, error.message);
        }
        if (DELAY_MS > 0) await sleep(DELAY_MS);
      }

      emitToUser(id, 'repricerLiveSyncStatus', {
        event: 'REPRICER_SYNC_COMPLETED',
        source,
        checked,
        updated,
        skipped,
        errors,
        message: `Repricer done: ${updated} updated, ${skipped} skipped, ${errors} errors`,
      });

      return { checked, updated, skipped, errors };
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
      this.runSyncForUser(uid, 'live_scheduled').catch((error) => {
        console.warn(`[Repricer] Scheduled run failed for ${uid}:`, error.message);
      }),
    );
    if (!registered) return;

    console.log(`[Repricer] Registered user ${id} (every ${INTERVAL_MS / 1000}s)`);
    // Kick once shortly after register so config changes take effect soon.
    setTimeout(() => {
      this.runSyncForUser(id, 'live_startup').catch(() => {});
    }, 5000);
  }

  unregisterUser(userId) {
    unregisterUserInterval(this, userId);
  }

  async reconcileUsers() {
    const users = await User.find({
      amazonRefreshToken: { $exists: true, $ne: null },
    })
      .select('_id')
      .lean();

    const activeIds = new Set(users.map((user) => String(user._id)));
    return reconcileUserTimers(
      this,
      activeIds,
      (userId) => this.registerUser(userId),
      (userId) => this.unregisterUser(userId),
    );
  }

  async startAll() {
    if (!ENABLED) {
      console.log('[Repricer] Disabled (REPRICER_LIVE_SYNC_ENABLED=false)');
      return;
    }
    if (this.started) return;
    this.started = true;
    await this.reconcileUsers();
    startReconcileLoop(this, RECONCILE_MS, () => this.reconcileUsers(), 'Repricer');
    console.log(
      `[Repricer] Live sync started — every ${INTERVAL_MS / 1000}s, ${BATCH_SIZE} products/cycle`,
    );
  }

  stopAll() {
    stopAllUserTimers(this, (userId) => this.unregisterUser(userId));
  }
}

const repricerLiveSyncScheduler = new RepricerLiveSyncScheduler();

module.exports = {
  repricerLiveSyncScheduler,
};
