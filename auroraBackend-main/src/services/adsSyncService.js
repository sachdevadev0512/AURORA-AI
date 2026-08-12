const User = require('../models/User');
const Ad = require('../models/Ad');
const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const { isAdsSellerAligned, purgeAdsIfMisaligned } = require('../utils/adsAccessGuard');
const { syncCampaignMetricsForUser } = require('./adsReportService');

const ADS_LIVE_SYNC_INTERVAL_MS = Math.max(
  5 * 60 * 1000,
  parseInt(process.env.ADS_LIVE_SYNC_INTERVAL_MS || '300000', 10)
);
const ADS_LIVE_SYNC_RECONCILE_MS = Math.max(
  60 * 1000,
  parseInt(process.env.ADS_LIVE_SYNC_RECONCILE_MS || '120000', 10)
);

function normalizeAdStatus(state) {
  const normalized = String(state || '').toLowerCase();
  if (normalized === 'enabled' || normalized === 'active') return 'Active';
  if (normalized === 'paused') return 'Paused';
  return 'Archived';
}

function mapAmazonAdToDocument(sellerId, ad) {
  return {
    sellerId,
    profileId: String(ad.profileId),
    campaignId: String(ad.campaignId),
    campaignName: ad.name,
    status: normalizeAdStatus(ad.state),
    country: ad.marketplace,
    campaignType: ad.campaignType,
    portfolio: ad.portfolioId,
    startDate: ad.startDate,
    endDate: ad.endDate,
    budget: { amount: ad.dailyBudget, currencyCode: ad.currency },
    lastSynced: new Date(),
  };
}

/**
 * Core campaign sync — campaign list from Ads API, then performance metrics from Reporting API.
 */
async function syncCampaignsForUser(user, options = {}) {
  const sellerId = user._id;

  if (!user.amazonRefreshToken) {
    const error = new Error(
      'Amazon Selling Partner credentials not configured. Connect your Amazon account first.'
    );
    error.code = 'SP_NOT_CONNECTED';
    throw error;
  }

  if (!user.amazonAdsRefreshToken) {
    const error = new Error(
      'Amazon Ads is not connected. Connect Amazon Ads from the integration page before syncing campaigns.'
    );
    error.code = 'ADS_NOT_CONNECTED';
    throw error;
  }

  const alignment = isAdsSellerAligned(user);
  if (user.amazonSellerId && user.amazonAdsAccountId && !alignment.aligned) {
    await Ad.deleteMany({ sellerId });
    const error = new Error(
      `Amazon Ads account (${alignment.adsAccount}) does not match Seller Central (${alignment.spSeller}). Reconnect Amazon Ads with the correct advertising login.`
    );
    error.code = 'ADS_SELLER_MISMATCH';
    error.details = {
      expectedSellerId: alignment.spSeller,
      adsAccountIds: [alignment.adsAccount],
    };
    throw error;
  }

  const sellerAppCredentials = await getSellerAppCredentials(user._id);
  const amazonAPI = new AmazonAPI(user, sellerAppCredentials);
  let amazonAds;
  try {
    amazonAds = await amazonAPI.getAds();
  } catch (error) {
    // Transient/partial profiles response — Amazon returned profiles we could not
    // attribute to an account. Never delete campaigns for this; keep existing data
    // and let the next cycle recover.
    if (error.code === 'ADS_PROFILES_INDETERMINATE') {
      console.warn(
        `[AdsSync] Indeterminate Amazon Ads profiles for ${sellerId}; keeping existing campaigns and retrying next cycle.`,
      );
      return {
        message: 'Ads sync skipped: Amazon Ads profiles were temporarily unavailable. Existing campaigns kept.',
        count: 0,
        skipped: true,
      };
    }
    if (error.code === 'ADS_SELLER_MISMATCH') {
      await Ad.deleteMany({ sellerId });
      await User.findByIdAndUpdate(sellerId, {
        amazonAdsProfileIds: [],
        amazonAdsAccountId: error.details?.adsAccountIds?.[0] || null,
      });
    }
    throw error;
  }

  if (amazonAds.length === 0) {
    return {
      message: 'No campaigns found in your Amazon account.',
      count: 0,
    };
  }

  const ads = amazonAds
    .filter((ad) => ad.campaignId && ad.profileId)
    .map((ad) => mapAmazonAdToDocument(sellerId, ad));

  const syncedProfileIds = [...new Set(ads.map((ad) => ad.profileId))];

  if (syncedProfileIds.length > 0) {
    await Ad.deleteMany({
      sellerId,
      $or: [
        { profileId: { $exists: false } },
        { profileId: null },
        { profileId: '' },
        { profileId: { $nin: syncedProfileIds } },
      ],
    });
  }

  for (const adData of ads) {
    await Ad.findOneAndUpdate(
      { campaignId: adData.campaignId, profileId: adData.profileId, sellerId },
      {
        $set: {
          sellerId: adData.sellerId,
          profileId: adData.profileId,
          campaignId: adData.campaignId,
          campaignName: adData.campaignName,
          status: adData.status,
          country: adData.country,
          campaignType: adData.campaignType,
          portfolio: adData.portfolio,
          startDate: adData.startDate,
          endDate: adData.endDate,
          budget: adData.budget,
          lastSynced: adData.lastSynced,
        },
      },
      { upsert: true, new: true }
    );
  }

  const syncedAt = new Date();
  await User.findByIdAndUpdate(sellerId, {
    lastAdsSyncedAt: syncedAt,
    amazonAdsProfileIds: syncedProfileIds,
    amazonAdsAccountId: user.amazonSellerId,
    updatedAt: syncedAt,
  });

  let campaignsRebuilt = 0;
  try {
    const { rebuildLifetimeFromAllStoredDaily } = require('./adsAutomatedLifetimeService');
    campaignsRebuilt = await rebuildLifetimeFromAllStoredDaily(sellerId);
    if (campaignsRebuilt > 0) {
      console.log(
        `[AdsSync] Rebuilt lifetime metrics for ${campaignsRebuilt} campaign(s) after campaign list sync (${sellerId})`,
      );
    }
  } catch (rebuildError) {
    console.warn(`[AdsSync] Lifetime rebuild after campaign sync failed for ${sellerId}:`, rebuildError.message);
  }

  // New / empty accounts: campaign list sync alone leaves Spend/Sales at $0.
  // Kick metrics in the background whenever we have no daily performance rows yet.
  try {
    const AdMetricsDaily = require('../models/AdMetricsDaily');
    const hasDaily = await AdMetricsDaily.exists({ sellerId, source: 'DAILY' });
    if (!hasDaily) {
      const { syncCampaignMetricsForUser } = require('./adsReportService');
      void syncCampaignMetricsForUser(await User.findById(sellerId) || user, { force: false })
        .then((metricsResult) => {
          if (metricsResult?.reportsQueued > 0 || metricsResult?.reportsRequested > 0) {
            console.log(
              `[AdsSync] Queued lifetime metrics after campaign sync for ${sellerId} `
              + `(${metricsResult.reportsQueued || metricsResult.reportsRequested} report(s))`,
            );
          }
        })
        .catch((metricsErr) => {
          console.warn(
            `[AdsSync] Background metrics after campaign sync failed for ${sellerId}:`,
            metricsErr.message,
          );
        });
    }
  } catch (metricsKickErr) {
    console.warn(
      `[AdsSync] Could not kick metrics after campaign sync for ${sellerId}:`,
      metricsKickErr.message,
    );
  }

  return {
    message: 'Ads synced successfully',
    count: ads.length,
    campaignsRebuilt,
    lastSyncAt: syncedAt.toISOString(),
  };
}

/**
 * Campaign list + 90-day performance metrics (used for manual sync).
 */
async function syncAdsFullForUser(user, options = {}) {
  const campaignResult = await syncCampaignsForUser(user);

  let metricsResult = null;
  try {
    const freshUser = await User.findById(user._id);
    metricsResult = await syncCampaignMetricsForUser(freshUser || user, {
      force: options.forceMetrics !== false,
      days: options.metricsDays,
    });
  } catch (metricsError) {
    console.error(`[AdsSync] Metrics sync failed for ${user._id}:`, metricsError.message);
    metricsResult = {
      skipped: false,
      error: metricsError.message,
      code: metricsError.code,
    };
  }

  const campaignsUpdated = metricsResult?.campaignsUpdated || 0;
  let message = campaignResult.message;
  if (metricsResult?.error) {
    message = `${message}. Metrics sync failed: ${metricsResult.error}`;
  } else if (metricsResult?.skipped) {
    message = `${message}. ${metricsResult.message || 'Metrics sync skipped.'}`;
  } else if (campaignsUpdated > 0) {
    message = `Ads synced with performance data (${campaignsUpdated} campaign(s) updated for last ${metricsResult?.metricsStartDate || '90d'} → ${metricsResult?.metricsEndDate || 'today'})`;
  } else if (metricsResult?.reportErrors > 0) {
    message = `${message}. Metrics reports failed (${metricsResult.reportErrors} error(s)) — check backend logs.`;
  } else {
    message = `${message}. No performance data returned from Amazon for this date range.`;
  }

  return {
    ...campaignResult,
    message,
    metrics: metricsResult,
  };
}

const { emitToUser } = require('../utils/socketEmit');
const {
  reconcileUserTimers,
  startReconcileLoop,
  stopReconcileLoop,
} = require('./sync/perUserScheduler');

/**
 * Server-side live sync — runs on an interval per user, independent of frontend/login.
 */
class AdsLiveSyncScheduler {
  constructor() {
    /** @type {Map<string, NodeJS.Timeout>} */
    this.userTimers = new Map();
    /** @type {Map<string, Promise>} */
    this.activeSyncs = new Map();
    /** @type {Map<string, Date>} */
    this.lastSyncAt = new Map();
    /** @type {Map<string, string>} */
    this.lastError = new Map();
    this.reconcileTimer = null;
    /** @type {Map<string, NodeJS.Timeout>} */
    this.metricsTimers = new Map();
    this.started = false;
  }

  getStatus(userId) {
    const id = String(userId);
    return {
      registered: this.userTimers.has(id),
      isSyncing: this.activeSyncs.has(id),
      lastSyncAt: this.lastSyncAt.get(id)?.toISOString() ?? null,
      lastError: this.lastError.get(id) ?? null,
      intervalMs: ADS_LIVE_SYNC_INTERVAL_MS,
      intervalMinutes: Math.round(ADS_LIVE_SYNC_INTERVAL_MS / 60000),
    };
  }

  async runSyncForUser(userId, source = 'scheduled') {
    const id = String(userId);

    if (this.activeSyncs.has(id)) {
      return { skipped: true, reason: 'sync_already_in_progress' };
    }

    const syncPromise = (async () => {
      const user = await User.findById(id);
      if (!user?.amazonAdsRefreshToken || !user.amazonRefreshToken) {
        this.unregisterUser(id);
        return { skipped: true, reason: 'ads_not_connected' };
      }

      emitToUser(id, 'adsSyncStatus', { event: 'ADS_SYNC_STATUS', status: 'syncing', source });

      try {
        const result = await syncCampaignsForUser(user);
        const syncedAt = new Date(result.lastSyncAt || Date.now());
        this.lastSyncAt.set(id, syncedAt);
        this.lastError.delete(id);

        emitToUser(id, 'adsSyncComplete', {
          event: 'ADS_SYNC_COMPLETE',
          source,
          message: result.message,
          count: result.count,
          lastSyncAt: syncedAt.toISOString(),
        });

        try {
          const appNotificationService = require('./appNotificationService');
          await appNotificationService.createNotification(id, {
            source: 'aurora',
            type: 'ads_sync',
            title: 'Aurora: Campaigns synced',
            message: result.message || `${result.count} campaign(s) updated`,
            link: '/ads',
            metadata: { count: result.count, syncSource: source, lastSyncAt: syncedAt.toISOString() },
          });
        } catch (notifyErr) {
          console.warn(`[AdsLiveSync] Inbox notification failed for ${id}:`, notifyErr.message);
        }

        return { success: true, ...result, source };
      } catch (error) {
        this.lastError.set(id, error.message);
        emitToUser(id, 'adsSyncError', {
          event: 'ADS_SYNC_ERROR',
          source,
          message: error.message,
          code: error.code,
        });

        try {
          const appNotificationService = require('./appNotificationService');
          await appNotificationService.createNotification(id, {
            source: 'aurora',
            type: 'ads_sync_error',
            title: 'Aurora: Campaign sync failed',
            message: error.message,
            link: '/ads',
            metadata: { syncSource: source, code: error.code },
          });
        } catch (notifyErr) {
          console.warn(`[AdsLiveSync] Inbox error notification failed for ${id}:`, notifyErr.message);
        }

        if (error.code === 'ADS_SELLER_MISMATCH') {
          this.unregisterUser(id);
        }

        console.error(`[AdsLiveSync] Sync failed for ${id} (${source}):`, error.message);
        throw error;
      }
    })().finally(() => {
      this.activeSyncs.delete(id);
    });

    this.activeSyncs.set(id, syncPromise);
    return syncPromise;
  }

  async ensureRegisteredForUser(userId) {
    const id = String(userId);
    const user = await User.findById(id).select(
      'amazonRefreshToken amazonAdsRefreshToken amazonSellerId amazonAdsAccountId'
    );

    if (!user?.amazonRefreshToken || !user?.amazonAdsRefreshToken) {
      if (this.userTimers.has(id)) {
        this.unregisterUser(id);
      }
      return { registered: false, reason: 'missing_tokens' };
    }

    if (user.amazonSellerId && user.amazonAdsAccountId && !isAdsSellerAligned(user).aligned) {
      if (this.userTimers.has(id)) {
        this.unregisterUser(id);
      }
      console.warn(`[AdsLiveSync] Skip user ${id}: Ads seller mismatch (SP=${user.amazonSellerId}, Ads=${user.amazonAdsAccountId})`);
      return { registered: false, reason: 'ads_seller_mismatch' };
    }

    if (!this.userTimers.has(id)) {
      this.registerUser(id);
    }

    return { registered: true };
  }

  runMetricsSyncForUser(userId, source = 'metrics_scheduled') {
    const id = String(userId);

    if (this.activeSyncs.has(`${id}:metrics`)) {
      return this.activeSyncs.get(`${id}:metrics`);
    }

    const metricsPromise = (async () => {
      const user = await User.findById(id);
      if (!user?.amazonAdsRefreshToken) {
        return { skipped: true, reason: 'ads_not_connected' };
      }

      try {
        const result = await syncCampaignMetricsForUser(user, {
          force: false,
        });

        emitToUser(id, 'adsSyncComplete', {
          event: 'ADS_METRICS_SYNC_COMPLETE',
          source,
          message: result.message,
          campaignsUpdated: result.campaignsUpdated,
        });

        return result;
      } catch (error) {
        console.error(`[AdsLiveSync] Metrics sync failed for ${id} (${source}):`, error.message);
        emitToUser(id, 'adsSyncError', {
          event: 'ADS_METRICS_SYNC_ERROR',
          source,
          message: error.message,
        });
        throw error;
      }
    })().finally(() => {
      this.activeSyncs.delete(`${id}:metrics`);
    });

    this.activeSyncs.set(`${id}:metrics`, metricsPromise);
    return metricsPromise;
  }

  registerUser(userId) {
    const id = String(userId);

    if (this.userTimers.has(id)) {
      return;
    }

    this.runSyncForUser(id, 'live_sync_initial').catch(() => {});

    // Default ON so new accounts get lifetime metrics without a manual Sync click.
    // Set ADS_METRICS_SYNC_ON_REGISTER=false to disable.
    const metricsOnRegister = process.env.ADS_METRICS_SYNC_ON_REGISTER !== 'false';
    if (metricsOnRegister) {
      setTimeout(() => {
        this.runMetricsSyncForUser(id, 'metrics_initial').catch(() => {});
      }, Math.max(15000, parseInt(process.env.ADS_METRICS_SYNC_STARTUP_DELAY_MS || '30000', 10)));
    }

    const timerId = setInterval(() => {
      this.runSyncForUser(id, 'live_sync_scheduled').catch(() => {});
    }, ADS_LIVE_SYNC_INTERVAL_MS);

    const metricsIntervalMs = Math.max(
      60 * 60 * 1000,
      parseInt(process.env.ADS_METRICS_SYNC_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10)
    );
    const metricsTimerId = setInterval(() => {
      this.runMetricsSyncForUser(id, 'metrics_scheduled').catch(() => {});
    }, metricsIntervalMs);

    this.userTimers.set(id, timerId);
    this.metricsTimers.set(id, metricsTimerId);
  }

  unregisterUser(userId) {
    const id = String(userId);
    const timerId = this.userTimers.get(id);
    const metricsTimerId = this.metricsTimers.get(id);

    if (timerId) {
      clearInterval(timerId);
      this.userTimers.delete(id);
    }
    if (metricsTimerId) {
      clearInterval(metricsTimerId);
      this.metricsTimers.delete(id);
    }
  }

  async reconcileUsers() {
    const users = await User.find({
      amazonAdsRefreshToken: { $exists: true, $ne: null },
      amazonRefreshToken: { $exists: true, $ne: null },
    }).select('_id amazonSellerId amazonAdsAccountId');

    const eligibleUserIds = new Set(
      users
        .filter((user) => !user.amazonSellerId || !user.amazonAdsAccountId || isAdsSellerAligned(user).aligned)
        .map((user) => String(user._id))
    );

    return reconcileUserTimers(
      this,
      eligibleUserIds,
      (userId) => this.registerUser(userId),
      (userId) => this.unregisterUser(userId),
    );
  }

  async startAll() {
    if (this.started) {
      return;
    }

    await this.reconcileUsers();
    this.started = true;
    startReconcileLoop(this, ADS_LIVE_SYNC_RECONCILE_MS, () => this.reconcileUsers(), 'AdsLiveSync');
  }

  stopAll() {
    stopReconcileLoop(this);
    for (const userId of [...this.userTimers.keys()]) {
      this.unregisterUser(userId);
    }
    this.started = false;
  }
}

const adsLiveSyncScheduler = new AdsLiveSyncScheduler();

async function ensureAdsLiveSyncForUser(userId) {
  return adsLiveSyncScheduler.ensureRegisteredForUser(userId);
}

/** @type {Map<string, Promise>} */
const manualAdsSyncLocks = new Map();

async function runManualAdsSync(user) {
  const id = String(user._id);

  if (manualAdsSyncLocks.has(id)) {
    return manualAdsSyncLocks.get(id);
  }

  const syncPromise = (async () => {
    const campaignResult = await syncCampaignsForUser(user);

    void syncCampaignMetricsForUser((await User.findById(id)) || user, { force: true })
      .then((metricsResult) => {
        if (metricsResult.metricsSyncing) {
          emitToUser(id, 'adsSyncComplete', {
            event: 'ADS_METRICS_SYNC_QUEUED',
            source: 'manual_metrics',
            message: metricsResult.message,
            reportsQueued: metricsResult.reportsQueued,
            metricsStartDate: metricsResult.metricsStartDate,
            metricsEndDate: metricsResult.metricsEndDate,
          });
          return;
        }
        emitToUser(id, 'adsSyncComplete', {
          event: 'ADS_METRICS_SYNC_COMPLETE',
          source: 'manual_metrics',
          message: metricsResult.message,
          campaignsUpdated: metricsResult.campaignsUpdated,
          metricsStartDate: metricsResult.metricsStartDate,
          metricsEndDate: metricsResult.metricsEndDate,
          reportErrors: metricsResult.reportErrors,
        });
      })
      .catch((error) => {
        console.error(`[AdsSync] Background metrics failed for ${id}:`, error.message);
        emitToUser(id, 'adsSyncError', {
          event: 'ADS_METRICS_SYNC_ERROR',
          source: 'manual_metrics',
          message: error.message,
        });
      });

    return {
      ...campaignResult,
      metricsSyncing: true,
      message:
        campaignResult.campaignsRebuilt > 0
          ? `${campaignResult.message} Applied stored metrics to ${campaignResult.campaignsRebuilt} campaign(s). Fetching more lifetime history in the background.`
          : `${campaignResult.message} Fetching lifetime performance metrics in the background (may take 5–20 minutes). The table will refresh automatically when ready.`,
    };
  })().finally(() => {
    manualAdsSyncLocks.delete(id);
  });

  manualAdsSyncLocks.set(id, syncPromise);
  return syncPromise;
}

module.exports = {
  syncCampaignsForUser,
  syncAdsFullForUser,
  runManualAdsSync,
  ensureAdsLiveSyncForUser,
  adsLiveSyncScheduler,
  ADS_LIVE_SYNC_INTERVAL_MS,
  normalizeAdStatus,
};
