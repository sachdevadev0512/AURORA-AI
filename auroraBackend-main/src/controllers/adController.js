const Ad = require('../models/Ad');
const AdMetricsDaily = require('../models/AdMetricsDaily');
const AdReportJob = require('../models/AdReportJob');
const Joi = require('joi');
const {
  runManualAdsSync,
  adsLiveSyncScheduler,
  ensureAdsLiveSyncForUser,
} = require('../services/adsSyncService');
const {
  createAmazonCampaign,
  getAdsProfiles,
  getAdsPortfolios,
} = require('../services/campaignCreateService');
const { loadUserForAmazon } = require('../utils/userLoader');
const {
  loadUserAdsContext,
  buildAdsReadQuery,
  purgeAdsIfMisaligned,
  isAdsSellerAligned,
} = require('../utils/adsAccessGuard');
const { buildCaseInsensitiveRegex } = require('../utils/regexSearch');
const {
  aggregateCampaignMetricsForRange,
  aggregateStatsForRange,
  aggregateLifetimeStats,
  overlayMetricsOnAd,
  applyLifetimeMetricsToAd,
  normalizeAdMetrics,
  getLifetimeDataBounds,
  hasDailyMetricsForRange,
  getDailyCoverageGaps,
  resolveMetricsPeriod,
  sortAdsWithMetrics,
  paginateArray,
  formatMetricsPeriodResponse,
} = require('../services/adsMetricsService');
const { queueMetricsReportsForUser } = require('../services/adsReportQueueService');
const { buildAdsReportCsv, buildAdsReportFilename } = require('../services/adsExportService');
const { METRICS_THROTTLE_MS, getLifetimeMetricsPeriodForUser } = require('../services/adsReportService');

const READ_QUEUE_COOLDOWN_MS = Math.max(
  5 * 60 * 1000,
  parseInt(process.env.ADS_READ_QUEUE_COOLDOWN_MS || String(30 * 60 * 1000), 10),
);

/** @type {Map<string, number>} */
const lastReadQueueAt = new Map();

function shouldThrottleReadQueue(sellerId, queueKey) {
  const mapKey = `${sellerId}:${queueKey}`;
  const lastAt = lastReadQueueAt.get(mapKey) || 0;
  if (Date.now() - lastAt < READ_QUEUE_COOLDOWN_MS) {
    return true;
  }
  lastReadQueueAt.set(mapKey, Date.now());
  return false;
}

const adSchema = Joi.object({
  campaignName: Joi.string().required(),
  status: Joi.string().valid('Active', 'Paused', 'Archived').required(),
  country: Joi.string().allow('', null),
  campaignType: Joi.string()
    .valid('Sponsored Products', 'Sponsored Brands', 'Sponsored Display')
    .required(),
  portfolio: Joi.string().allow('', null),
  startDate: Joi.date().allow(null),
  endDate: Joi.date().allow(null),
  budget: Joi.object({
    amount: Joi.number().min(0),
    currencyCode: Joi.string(),
  }),
});

const adUpdateSchema = adSchema.fork(['campaignName', 'status', 'campaignType'], (field) => field.optional());

function buildAdsFilterQuery(adsUser, reqQuery) {
  const { query, blocked, alignment } = buildAdsReadQuery(adsUser);

  if (reqQuery.status) {
    query.status = reqQuery.status;
  }

  if (reqQuery.campaignType) {
    query.campaignType = reqQuery.campaignType;
  }

  if (reqQuery.search) {
    const search = String(reqQuery.search).trim();
    const searchRegex = buildCaseInsensitiveRegex(search);
    if (searchRegex) {
      query.$or = [
        { campaignName: searchRegex },
        { campaignId: searchRegex },
        { country: searchRegex },
      ];
    }
  }

  return { query, blocked, alignment };
}

async function getAdsProfilesForUser(user) {
  try {
    const loaded = await loadUserForAmazon(user._id);
    if (!loaded?.amazonAdsRefreshToken) return [];
    const profiles = await getAdsProfiles(loaded);
    return profiles || [];
  } catch {
    return [];
  }
}

async function maybeQueueCustomRangeReports(user, metricsPeriod) {
  if (!metricsPeriod?.isCustomRange) return null;

  const rangeKey = `custom:${metricsPeriod.startYmd}:${metricsPeriod.endYmd}`;
  if (shouldThrottleReadQueue(user._id, rangeKey)) return null;

  const gaps = await getDailyCoverageGaps(
    user._id,
    metricsPeriod.startYmd,
    metricsPeriod.endYmd,
  );
  if (gaps.length === 0) return null;

  const inFlight = await AdReportJob.countDocuments({
    sellerId: user._id,
    status: { $in: ['PENDING', 'PROCESSING'] },
    isCustomRange: true,
  });
  if (inFlight > 0) return null;

  try {
    const loaded = await loadUserForAmazon(user._id);
    if (!loaded?.amazonAdsRefreshToken) return null;

    void queueMetricsReportsForUser(loaded, {
      startDate: metricsPeriod.startYmd,
      endDate: metricsPeriod.endYmd,
      chunks: gaps,
      force: false,
    }).catch((error) => {
      console.warn('[adController] Custom range report queue failed:', error.message);
    });

    return {
      reportsQueued: gaps.length,
      deferred: true,
      message:
        'Custom-range performance reports are syncing in the background. Refresh in a few minutes.',
    };
  } catch (error) {
    console.warn('[adController] Custom range report queue failed:', error.message);
    return null;
  }
}

async function buildMetricsPeriodResponse(adsUser, metricsPeriod, profiles = []) {
  if (!metricsPeriod.isLifetime) {
    const rangeBounds = await getLifetimeDataBounds(adsUser._id);
    return formatMetricsPeriodResponse(metricsPeriod, rangeBounds);
  }
  const dataBounds = await getLifetimeDataBounds(adsUser._id);
  const lifetimeTarget = await getLifetimeMetricsPeriodForUser(adsUser, profiles);
  return formatMetricsPeriodResponse(metricsPeriod, dataBounds, lifetimeTarget);
}

async function buildMetricsContext(adsUser, reqQuery) {
  const profiles = await getAdsProfilesForUser(adsUser);
  const metricsPeriod = resolveMetricsPeriod(reqQuery, adsUser, profiles);

  if (metricsPeriod.isLifetime) {
    return {
      profiles,
      metricsPeriod,
      metricsByKey: new Map(),
      hasDailyMetrics: false,
    };
  }

  const metricsByKey = await aggregateCampaignMetricsForRange(
    adsUser._id,
    metricsPeriod.startYmd,
    metricsPeriod.endYmd,
    {
      campaignType: reqQuery.campaignType || undefined,
    },
  );

  const hasDailyMetrics = await hasDailyMetricsForRange(
    adsUser._id,
    metricsPeriod.startYmd,
    metricsPeriod.endYmd,
  );

  return {
    profiles,
    metricsPeriod,
    metricsByKey,
    hasDailyMetrics,
  };
}

function prepareAdsWithMetrics(allAds, metricsContext) {
  if (metricsContext.metricsPeriod.isLifetime) {
    return allAds.map(applyLifetimeMetricsToAd);
  }

  if (metricsContext.metricsPeriod.isCustomRange) {
    return overlayAdsWithPeriodMetrics(allAds, metricsContext.metricsByKey, {
      fallbackToStored: false,
    });
  }

  if (metricsContext.hasDailyMetrics) {
    return overlayAdsWithPeriodMetrics(allAds, metricsContext.metricsByKey, {
      fallbackToStored: false,
    });
  }

  return allAds.map((ad) => normalizeAdMetrics(ad));
}

function overlayAdsWithPeriodMetrics(ads, metricsByKey, options = {}) {
  const fallbackToStored = options.fallbackToStored === true;

  return ads.map((ad) => {
    const key = `${ad.profileId}:${ad.campaignId}`;
    const metrics = metricsByKey.get(key);
    if (!metrics) {
      if (fallbackToStored) {
        return normalizeAdMetrics(ad);
      }
      return normalizeAdMetrics({
        ...ad,
        impressions: 0,
        clicks: 0,
        orders: 0,
        ctr: 0,
        cpc: 0,
        acos: 0,
        roas: 0,
        spend: { amount: 0, currencyCode: ad.spend?.currencyCode || 'USD' },
        sales: { amount: 0, currencyCode: ad.sales?.currencyCode || 'USD' },
      });
    }
    return normalizeAdMetrics(overlayMetricsOnAd(ad, metrics));
  });
}

async function maybeQueueMetricsIfEmpty(user, metricsContext) {
  if (!metricsContext.metricsPeriod.isLifetime) return null;

  if (shouldThrottleReadQueue(user._id, 'lifetime-empty')) return null;

  const hasStoredMetrics = await Ad.exists({
    sellerId: user._id,
    $or: [
      { lifetimeImpressions: { $gt: 0 } },
      { lifetimeClicks: { $gt: 0 } },
      { 'lifetimeSpend.amount': { $gt: 0 } },
      { impressions: { $gt: 0 } },
      { clicks: { $gt: 0 } },
      { 'spend.amount': { $gt: 0 } },
    ],
  });
  if (hasStoredMetrics) return null;

  const hasDailyRows = await AdMetricsDaily.exists({ sellerId: user._id, source: 'DAILY' });
  if (hasDailyRows) return null;

  if (user.lastAdsMetricsSyncedAt) {
    const elapsed = Date.now() - new Date(user.lastAdsMetricsSyncedAt).getTime();
    if (elapsed < METRICS_THROTTLE_MS) return null;
  }

  const inFlight = await AdReportJob.countDocuments({
    sellerId: user._id,
    status: { $in: ['PENDING', 'PROCESSING'] },
  });
  if (inFlight > 0) return null;

  try {
    const loaded = await loadUserForAmazon(user._id);
    if (!loaded?.amazonAdsRefreshToken) return null;

    // Fire-and-forget: awaiting the full V1 queue here blocks getAds for minutes
    // (and used to deadlock the create lock), so the UI never got metrics jobs.
    void queueMetricsReportsForUser(loaded, { force: false, days: 95 })
      .then((result) => {
        if (result?.reportsQueued > 0) {
          console.log(
            `[adController] Auto-queued ${result.reportsQueued} metrics report(s) for empty lifetime (${user._id})`,
          );
        } else if (result?.rateLimited) {
          console.warn(
            `[adController] Auto metrics queue rate-limited for ${user._id}: ${result.message}`,
          );
        }
      })
      .catch((error) => {
        console.warn('[adController] Auto metrics queue failed:', error.message);
      });

    return {
      reportsQueued: 1,
      deferred: true,
      message:
        'Lifetime performance metrics are syncing in the background. Totals will fill in as Amazon reports complete.',
    };
  } catch (error) {
    console.warn('[adController] Auto metrics queue failed:', error.message);
    return null;
  }
}

exports.getAds = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 25;
    const sortBy = req.query.sortBy || 'campaignName';
    const sortOrder = req.query.sortOrder === 'desc' ? 'desc' : 'asc';

    const adsUser = await loadUserAdsContext(req.user._id);
    if (!adsUser) {
      return res.status(401).json({ message: 'User not found' });
    }

    if (!isAdsSellerAligned(adsUser).aligned && adsUser.amazonAdsRefreshToken) {
      await purgeAdsIfMisaligned(req.user._id);
    }

    const { query, blocked, alignment } = buildAdsFilterQuery(adsUser, req.query);

    const metricsContext = await buildMetricsContext(adsUser, req.query);
    const queueResult =
      (await maybeQueueCustomRangeReports(adsUser, metricsContext.metricsPeriod)) ||
      (await maybeQueueMetricsIfEmpty(adsUser, metricsContext));

    const allAds = await Ad.find(query).lean();
    const adsWithMetrics = prepareAdsWithMetrics(allAds, metricsContext);

    const sortedAds = sortAdsWithMetrics(adsWithMetrics, sortBy, sortOrder);
    const paged = paginateArray(sortedAds, page, limit);

    res.json({
      ads: paged.items,
      pagination: {
        page,
        limit,
        total: paged.total,
        pages: paged.pages,
      },
      totalAds: paged.total,
      currentPage: page,
      totalPages: paged.pages,
      adsAccessBlocked: blocked,
      adsSellerMismatch: blocked ? alignment : null,
      metricsPeriod: await buildMetricsPeriodResponse(
        adsUser,
        metricsContext.metricsPeriod,
        metricsContext.profiles,
      ),
      metricsSyncing: queueResult?.reportsQueued > 0,
      reportErrors: queueResult?.reportErrors || [],
    });
  } catch (error) {
    console.error('[getAds] Error:', error);
    res.status(500).json({ message: error.message });
  }
};

exports.getAd = async (req, res) => {
  try {
    const ad = await Ad.findOne({ _id: req.params.id, sellerId: req.user._id });

    if (!ad) {
      return res.status(404).json({ message: 'Campaign not found' });
    }

    res.json(ad);
  } catch (error) {
    console.error('[getAd] Error:', error);
    res.status(500).json({ message: error.message });
  }
};

exports.createAd = async (req, res) => {
  try {
    const { error, value } = adSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ message: error.details[0].message });
    }

    const ad = await Ad.create({
      ...value,
      sellerId: req.user._id,
      campaignId: `CAMP_${Date.now()}`,
    });

    res.status(201).json(ad);
  } catch (error) {
    console.error('[createAd] Error:', error);
    res.status(500).json({ message: error.message });
  }
};

exports.updateAd = async (req, res) => {
  try {
    const { error, value } = adUpdateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ message: error.details[0].message });
    }

    const ad = await Ad.findOneAndUpdate(
      { _id: req.params.id, sellerId: req.user._id },
      { ...value, updatedAt: new Date() },
      { new: true, runValidators: true },
    );

    if (!ad) {
      return res.status(404).json({ message: 'Campaign not found' });
    }

    res.json(ad);
  } catch (error) {
    console.error('[updateAd] Error:', error);
    res.status(500).json({ message: error.message });
  }
};

exports.deleteAd = async (req, res) => {
  try {
    const ad = await Ad.findOneAndDelete({ _id: req.params.id, sellerId: req.user._id });

    if (!ad) {
      return res.status(404).json({ message: 'Campaign not found' });
    }

    res.status(204).send();
  } catch (error) {
    console.error('[deleteAd] Error:', error);
    res.status(500).json({ message: error.message });
  }
};

exports.getAdStats = async (req, res) => {
  try {
    const adsUser = await loadUserAdsContext(req.user._id);
    if (!adsUser) {
      return res.status(401).json({ message: 'User not found' });
    }

    if (!isAdsSellerAligned(adsUser).aligned && adsUser.amazonAdsRefreshToken) {
      await purgeAdsIfMisaligned(req.user._id);
    }

    const { query: baseQuery, blocked } = buildAdsReadQuery(adsUser);
    const metricsContext = await buildMetricsContext(adsUser, req.query);
    const queueResult =
      (await maybeQueueCustomRangeReports(adsUser, metricsContext.metricsPeriod)) ||
      (await maybeQueueMetricsIfEmpty(adsUser, metricsContext));

    const [totalAds, activeAds] = await Promise.all([
      Ad.countDocuments(baseQuery),
      Ad.countDocuments({ ...baseQuery, status: 'Active' }),
    ]);

    let stats;
    if (metricsContext.metricsPeriod.isLifetime) {
      stats = await aggregateLifetimeStats(adsUser._id, {
        campaignType: req.query.campaignType || undefined,
      });
    } else if (metricsContext.hasDailyMetrics || metricsContext.metricsPeriod.isCustomRange) {
      stats = await aggregateStatsForRange(
        adsUser._id,
        metricsContext.metricsPeriod.startYmd,
        metricsContext.metricsPeriod.endYmd,
        {
          campaignType: req.query.campaignType || undefined,
        },
      );
    } else {
      const aggregateStats = await Ad.aggregate([
        { $match: baseQuery },
        {
          $group: {
            _id: null,
            totalSpend: { $sum: { $ifNull: ['$spend.amount', 0] } },
            totalSales: { $sum: { $ifNull: ['$sales.amount', 0] } },
            totalImpressions: { $sum: { $ifNull: ['$impressions', 0] } },
            totalClicks: { $sum: { $ifNull: ['$clicks', 0] } },
            totalOrders: { $sum: { $ifNull: ['$orders', 0] } },
            avgAcos: { $avg: '$acos' },
            avgRoas: { $avg: '$roas' },
          },
        },
      ]);
      const result = aggregateStats[0] || {};
      stats = {
        totalSpend: result.totalSpend || 0,
        totalSales: result.totalSales || 0,
        totalImpressions: result.totalImpressions || 0,
        totalClicks: result.totalClicks || 0,
        totalOrders: result.totalOrders || 0,
        avgAcos: result.avgAcos || 0,
        avgRoas: result.avgRoas || 0,
      };
    }

    res.json({
      totalAds,
      activeAds,
      totalSpend: stats.totalSpend || 0,
      totalSales: stats.totalSales || 0,
      totalImpressions: stats.totalImpressions || 0,
      totalClicks: stats.totalClicks || 0,
      totalOrders: stats.totalOrders || 0,
      avgAcos: stats.avgAcos || 0,
      avgRoas: stats.avgRoas || 0,
      metricsPeriod: await buildMetricsPeriodResponse(
        adsUser,
        metricsContext.metricsPeriod,
        metricsContext.profiles,
      ),
      metricsSyncing: queueResult?.reportsQueued > 0,
      reportErrors: queueResult?.reportErrors || [],
      adsAccessBlocked: blocked,
    });
  } catch (error) {
    console.error('[getAdStats] Error:', error);
    res.status(500).json({ message: error.message });
  }
};

exports.exportAdsReport = async (req, res) => {
  try {
    const sortBy = req.query.sortBy || 'campaignName';
    const sortOrder = req.query.sortOrder === 'desc' ? 'desc' : 'asc';

    const adsUser = await loadUserAdsContext(req.user._id);
    if (!adsUser) {
      return res.status(401).json({ message: 'User not found' });
    }

    if (!isAdsSellerAligned(adsUser).aligned && adsUser.amazonAdsRefreshToken) {
      await purgeAdsIfMisaligned(req.user._id);
    }

    const { query, blocked } = buildAdsFilterQuery(adsUser, req.query);
    if (blocked) {
      return res.status(403).json({ message: 'Amazon Ads account is not aligned with Seller Central.' });
    }

    const metricsContext = await buildMetricsContext(adsUser, req.query);
    const allAds = await Ad.find(query).lean();
    const adsWithMetrics = prepareAdsWithMetrics(allAds, metricsContext);
    const sortedAds = sortAdsWithMetrics(adsWithMetrics, sortBy, sortOrder);

    const csv = buildAdsReportCsv(sortedAds, metricsContext.metricsPeriod);
    const filename = buildAdsReportFilename(metricsContext.metricsPeriod);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(`\uFEFF${csv}`);
  } catch (error) {
    console.error('[exportAdsReport] Error:', error);
    res.status(500).json({ message: error.message });
  }
};

exports.syncAds = async (req, res) => {
  try {
    const user = await loadUserForAmazon(req.user._id);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    await ensureAdsLiveSyncForUser(user._id);

    const result = await runManualAdsSync(user);
    try {
      const appNotificationService = require('../services/appNotificationService');
      await appNotificationService.createNotification(req.user._id, {
        source: 'aurora',
        type: 'ads_sync',
        title: 'Aurora: Campaigns synced',
        message: result.message || `${result.count} campaign(s) updated`,
        link: '/ads',
        metadata: { count: result.count, syncSource: 'manual_sync' },
      });
    } catch (notifyErr) {
      console.warn('[syncAds] Inbox notification failed:', notifyErr.message);
    }

    res.json({
      message: result.message,
      count: result.count,
      lastSyncAt: result.lastSyncAt,
      metricsSyncing: result.metricsSyncing === true,
      metrics: result.metrics,
    });
  } catch (error) {
    console.error('[syncAds] Error occurred:', error);

    if (
      error.code === 'ADS_NOT_CONNECTED' ||
      error.code === 'SP_NOT_CONNECTED' ||
      error.code === 'ADS_SELLER_MISMATCH'
    ) {
      return res.status(400).json({
        message: error.message,
        code: error.code,
        details: error.details,
      });
    }

    if (error.code === 'ADS_UNAUTHORIZED' || error.response?.status === 401) {
      return res.status(403).json({
        message:
          error.message ||
          'Amazon Ads authorization failed. Reconnect Amazon Ads and verify the app has Advertising API permissions.',
        code: 'ADS_UNAUTHORIZED',
      });
    }

    res.status(500).json({
      message: error.message,
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
};

exports.getSyncStatus = async (req, res) => {
  try {
    const User = require('../models/User');
    const schedulerStatus = adsLiveSyncScheduler.getStatus(req.user._id);
    const user = await User.findById(req.user._id).select('lastAdsSyncedAt');

    res.json({
      success: true,
      ...schedulerStatus,
      lastSyncAt: schedulerStatus.lastSyncAt || user?.lastAdsSyncedAt?.toISOString() || null,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getAdsProfiles = async (req, res) => {
  try {
    const user = await loadUserForAmazon(req.user._id);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    const profiles = await getAdsProfiles(user);
    res.json({ profiles });
  } catch (error) {
    console.error('[getAdsProfiles] Error:', error);
    if (
      error.code === 'ADS_NOT_CONNECTED' ||
      error.code === 'SP_NOT_CONNECTED' ||
      error.code === 'ADS_SELLER_MISMATCH'
    ) {
      return res.status(400).json({ message: error.message, code: error.code, details: error.details });
    }
    if (error.code === 'ADS_UNAUTHORIZED' || error.response?.status === 401) {
      return res.status(403).json({ message: error.message, code: 'ADS_UNAUTHORIZED' });
    }
    res.status(500).json({ message: error.message });
  }
};

exports.getAdsPortfolios = async (req, res) => {
  try {
    const user = await loadUserForAmazon(req.user._id);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    const profileId = req.query.profileId;
    const portfolios = await getAdsPortfolios(user, profileId);
    res.json({ portfolios });
  } catch (error) {
    console.error('[getAdsPortfolios] Error:', error.message);
    if (
      error.code === 'ADS_NOT_CONNECTED' ||
      error.code === 'SP_NOT_CONNECTED' ||
      error.code === 'ADS_SELLER_MISMATCH' ||
      error.code === 'VALIDATION_ERROR'
    ) {
      return res.status(400).json({ message: error.message, code: error.code, details: error.details });
    }
    if (error.code === 'ADS_UNAUTHORIZED' || error.response?.status === 401) {
      return res.status(403).json({ message: error.message, code: 'ADS_UNAUTHORIZED' });
    }
    res.json({ portfolios: [] });
  }
};

exports.createAmazonCampaign = async (req, res) => {
  try {
    const user = await loadUserForAmazon(req.user._id);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    const result = await createAmazonCampaign(user, req.body);

    try {
      const appNotificationService = require('../services/appNotificationService');
      await appNotificationService.createNotification(req.user._id, {
        source: 'aurora',
        type: 'ads_sync',
        title: 'Aurora: Campaign created',
        message: `"${req.body?.campaign?.name || result.campaignId}" was created on Amazon.`,
        link: '/ads',
        metadata: {
          campaignId: result.campaignId,
          campaignType: req.body?.campaignType,
        },
      });
    } catch (notifyErr) {
      console.warn('[createAmazonCampaign] Inbox notification failed:', notifyErr.message);
    }

    res.status(201).json(result);
  } catch (error) {
    console.error('[createAmazonCampaign] Error:', error);
    if (
      error.code === 'ADS_NOT_CONNECTED' ||
      error.code === 'SP_NOT_CONNECTED' ||
      error.code === 'ADS_SELLER_MISMATCH' ||
      error.code === 'VALIDATION_ERROR' ||
      error.code === 'PROFILE_NOT_FOUND' ||
      error.code === 'ADS_CREATE_FAILED'
    ) {
      return res.status(400).json({
        message: error.message,
        code: error.code,
        details: error.details,
      });
    }
    if (error.code === 'ADS_UNAUTHORIZED' || error.response?.status === 401) {
      return res.status(403).json({
        message: error.message || 'Amazon Ads authorization failed. Reconnect Amazon Ads.',
        code: 'ADS_UNAUTHORIZED',
      });
    }
    res.status(500).json({ message: error.message });
  }
};
