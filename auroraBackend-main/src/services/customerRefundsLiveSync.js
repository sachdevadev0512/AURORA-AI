/**
 * Periodic refund sync for every connected Amazon seller.
 *
 * Full order sync + Returned-tab refresh already pull refunds, but accounts that
 * are idle still need DEFERRED "Refund applied" rows for Return Proc. This
 * scheduler keeps listTransactions coverage current for all sellers.
 */
const User = require('../models/User');
const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const { syncCustomerRefunds } = require('./customerRefundsService');
const {
  createPerUserSchedulerState,
  registerUserInterval,
  unregisterUserInterval,
  reconcileUserTimers,
  startReconcileLoop,
  stopAllUserTimers,
} = require('./sync/perUserScheduler');

const ENABLED = process.env.CUSTOMER_REFUNDS_LIVE_SYNC_ENABLED !== 'false';
/** Default 6h — Finances walks are rate-limited; Return Proc does not need minute-level freshness. */
const INTERVAL_MS = Math.max(
  15 * 60 * 1000,
  parseInt(process.env.CUSTOMER_REFUNDS_LIVE_SYNC_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10),
);
const RECONCILE_MS = Math.max(
  5 * 60 * 1000,
  parseInt(process.env.CUSTOMER_REFUNDS_LIVE_SYNC_RECONCILE_MS || String(30 * 60 * 1000), 10),
);
/** Spread first-run across sellers so startup does not hammer Finances. */
const INITIAL_STAGGER_MS = Math.max(
  0,
  parseInt(process.env.CUSTOMER_REFUNDS_LIVE_SYNC_STAGGER_MS || '45000', 10),
);

class CustomerRefundsLiveSyncScheduler {
  constructor() {
    Object.assign(this, createPerUserSchedulerState());
    this.activeSyncs = new Map();
    this.lastRunByUser = new Map();
    this._registerOrder = 0;
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

      const creds = await getSellerAppCredentials(user._id);
      const amazonAPI = new AmazonAPI(user, creds);
      const stats = await syncCustomerRefunds(user, amazonAPI);
      const summary = {
        source,
        refundEventCount: stats?.refundEventCount || 0,
        txRefundCount: stats?.txRefundCount || 0,
        updatedOrders: stats?.updatedOrders || 0,
        at: new Date().toISOString(),
      };
      this.lastRunByUser.set(id, summary);

      if (summary.updatedOrders > 0 || summary.txRefundCount > 0) {
        console.log(
          `[CustomerRefundsLiveSync] user=${id} source=${source} ` +
            `tx=${summary.txRefundCount} updated=${summary.updatedOrders}`,
        );
      }
      return summary;
    })()
      .catch((error) => {
        console.warn(`[CustomerRefundsLiveSync] Failed for ${id}:`, error.message);
        return { skipped: true, reason: error.message };
      })
      .finally(() => {
        this.activeSyncs.delete(id);
      });

    this.activeSyncs.set(id, syncPromise);
    return syncPromise;
  }

  registerUser(userId) {
    const id = String(userId);
    if (this.userTimers.has(id)) return;

    const order = this._registerOrder;
    this._registerOrder += 1;
    const stagger = INITIAL_STAGGER_MS * order;
    setTimeout(() => {
      this.runSyncForUser(id, 'live_initial').catch(() => {});
    }, stagger);

    registerUserInterval(this, id, INTERVAL_MS, (uid) =>
      this.runSyncForUser(uid, 'live_scheduled'),
    );
    console.log(
      `[CustomerRefundsLiveSync] Registered user ${id} ` +
        `(every ${Math.round(INTERVAL_MS / 60000)}m, first run in ${Math.round(stagger / 1000)}s)`,
    );
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
      console.log('[CustomerRefundsLiveSync] Disabled (CUSTOMER_REFUNDS_LIVE_SYNC_ENABLED=false)');
      return;
    }
    if (this.started) return;

    await this.reconcileUsers();
    this.started = true;
    startReconcileLoop(this, RECONCILE_MS, () => this.reconcileUsers(), 'CustomerRefundsLiveSync');
    console.log(
      `[CustomerRefundsLiveSync] Started — every ${Math.round(INTERVAL_MS / 60000)}m per connected seller`,
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
      registered: id ? this.userTimers.has(id) : undefined,
      lastRun: id ? this.lastRunByUser.get(id) || null : null,
      registeredUsers: this.userTimers.size,
    };
  }
}

const customerRefundsLiveSyncScheduler = new CustomerRefundsLiveSyncScheduler();

async function ensureCustomerRefundsLiveSyncForUser(userId) {
  return customerRefundsLiveSyncScheduler.ensureRegisteredForUser(userId);
}

module.exports = {
  customerRefundsLiveSyncScheduler,
  ensureCustomerRefundsLiveSyncForUser,
};
