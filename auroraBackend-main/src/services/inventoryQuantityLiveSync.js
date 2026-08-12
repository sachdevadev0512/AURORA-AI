/**
 * Periodic live FBA quantity refresh for every connected seller.
 *
 * Full inventory sync (reports + listings) is heavy and only runs when the
 * seller clicks "Sync inventory". Between syncs, Seller Central keeps moving
 * while Aurora's products.inventory stays frozen on the last MYI report —
 * which is why Available / Inbound / Reserved disagree with Manage Inventory.
 *
 * This scheduler pulls getInventorySummaries (live SP-API) and writes only
 * the quantity fields onto existing Product rows. It does not recreate
 * listings, so it stays cheap and keeps every seller's Products table in
 * lockstep with Seller Central going forward.
 */

const User = require('../models/User');
const Product = require('../models/Product');
const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const { productInventorySetFromFbaItem } = require('../utils/fbaInventoryFields');
const { emitToUser } = require('../utils/socketEmit');
const {
  createPerUserSchedulerState,
  registerUserInterval,
  unregisterUserInterval,
  reconcileUserTimers,
  startReconcileLoop,
  stopAllUserTimers,
} = require('./sync/perUserScheduler');

const ENABLED = process.env.INVENTORY_QTY_LIVE_SYNC_ENABLED !== 'false';
const INTERVAL_MS = Math.max(
  5 * 60 * 1000,
  parseInt(process.env.INVENTORY_QTY_LIVE_SYNC_INTERVAL_MS || String(15 * 60 * 1000), 10)
);
const RECONCILE_MS = Math.max(
  60 * 1000,
  parseInt(process.env.INVENTORY_QTY_LIVE_SYNC_RECONCILE_MS || String(5 * 60 * 1000), 10)
);
const BULK_SIZE = Math.max(
  50,
  parseInt(process.env.INVENTORY_QTY_LIVE_SYNC_BULK_SIZE || '200', 10)
);

async function refreshInventoryQuantitiesForUser(user, { source = 'live_scheduled' } = {}) {
  if (!user?.amazonRefreshToken) {
    return { skipped: true, reason: 'amazon_not_connected' };
  }

  const sellerAppCredentials = await getSellerAppCredentials(user._id);
  if (!sellerAppCredentials?.amazonLwaClientId || !sellerAppCredentials?.amazonLwaClientSecret) {
    return { skipped: true, reason: 'missing_seller_app_credentials' };
  }

  const amazonAPI = new AmazonAPI(user, sellerAppCredentials);
  amazonAPI.setSpApiOptions({ label: `seller:${String(user._id)}:inventory-qty-live` });

  const summaries = await amazonAPI.getInventorySummaries();
  if (!Array.isArray(summaries) || summaries.length === 0) {
    return { updated: 0, scanned: 0, source };
  }

  const now = new Date();
  const ops = [];

  for (const live of summaries) {
    const sku = live?.sellerSku;
    if (!sku) continue;

    const set = productInventorySetFromFbaItem(live, { syncedAt: now });
    ops.push({
      updateOne: {
        filter: {
          sellerId: user._id,
          sku,
          // Never overwrite a seller's manual inventory override.
          $or: [
            { inventoryManualOverrideAt: { $exists: false } },
            { inventoryManualOverrideAt: null },
          ],
        },
        update: { $set: set },
      },
    });
  }

  let matched = 0;
  let modified = 0;
  for (let i = 0; i < ops.length; i += BULK_SIZE) {
    const chunk = ops.slice(i, i + BULK_SIZE);
    const result = await Product.bulkWrite(chunk, { ordered: false });
    matched += result.matchedCount || 0;
    modified += result.modifiedCount || 0;
  }

  // Count manual overrides we intentionally skipped (for diagnostics).
  const skippedManual = await Product.countDocuments({
    sellerId: user._id,
    inventoryManualOverrideAt: { $exists: true, $ne: null },
  });

  const userId = String(user._id);
  emitToUser(userId, 'inventoryQtyLiveSyncStatus', {
    event: 'INVENTORY_QTY_LIVE_SYNC_DONE',
    source,
    scanned: summaries.length,
    matched,
    modified,
    skippedManual,
    message: `Inventory quantities refreshed (${modified} updated)`,
  });

  console.log(
    `[InventoryQtyLiveSync] user=${userId} source=${source} scanned=${summaries.length} matched=${matched} modified=${modified}`
  );

  return {
    scanned: summaries.length,
    matched,
    modified,
    skippedManual,
    source,
  };
}

class InventoryQuantityLiveSyncScheduler {
  constructor() {
    Object.assign(this, createPerUserSchedulerState());
    this.activeSyncs = new Map();
  }

  async runForUser(userId, source = 'live_scheduled') {
    const id = String(userId);
    if (this.activeSyncs.has(id)) {
      return this.activeSyncs.get(id);
    }

    const promise = (async () => {
      const user = await User.findById(id);
      if (!user) return { skipped: true, reason: 'user_not_found' };
      return refreshInventoryQuantitiesForUser(user, { source });
    })()
      .catch((error) => {
        console.warn(`[InventoryQtyLiveSync] Failed for ${id}:`, error.message);
        return { skipped: true, reason: 'error', error: error.message };
      })
      .finally(() => {
        this.activeSyncs.delete(id);
      });

    this.activeSyncs.set(id, promise);
    return promise;
  }

  registerUser(userId) {
    if (!ENABLED) return;
    const id = String(userId);
    const registered = registerUserInterval(this, id, INTERVAL_MS, (uid) =>
      this.runForUser(uid, 'live_scheduled')
    );
    if (!registered) return;
    console.log(
      `[InventoryQtyLiveSync] Registered user ${id} (every ${Math.round(INTERVAL_MS / 60000)}m)`
    );
    // Kick once shortly after register so stale Products pages catch up
    // without waiting a full interval.
    setTimeout(() => {
      this.runForUser(id, 'startup').catch(() => {});
    }, 15000);
  }

  unregisterUser(userId) {
    unregisterUserInterval(this, userId);
  }

  async reconcileUsers() {
    const users = await User.find({
      amazonRefreshToken: { $exists: true, $ne: null },
      amazonSellerId: { $exists: true, $ne: null },
    })
      .select('_id')
      .lean();

    const activeIds = new Set(users.map((u) => String(u._id)));
    return reconcileUserTimers(
      this,
      activeIds,
      (userId) => this.registerUser(userId),
      (userId) => this.unregisterUser(userId)
    );
  }

  async startAll() {
    if (!ENABLED) {
      console.log('[InventoryQtyLiveSync] Disabled (INVENTORY_QTY_LIVE_SYNC_ENABLED=false)');
      return;
    }
    if (this.started) return;
    this.started = true;
    await this.reconcileUsers();
    startReconcileLoop(this, RECONCILE_MS, () => this.reconcileUsers(), 'InventoryQtyLiveSync');
    console.log(
      `[InventoryQtyLiveSync] Started — refreshing FBA quantities every ${Math.round(INTERVAL_MS / 60000)}m per seller`
    );
  }

  stopAll() {
    stopAllUserTimers(this, (userId) => this.unregisterUser(userId));
  }
}

const inventoryQuantityLiveSyncScheduler = new InventoryQuantityLiveSyncScheduler();

module.exports = {
  refreshInventoryQuantitiesForUser,
  inventoryQuantityLiveSyncScheduler,
};
