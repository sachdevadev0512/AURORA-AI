const User = require('../models/User');
const Ad = require('../models/Ad');
const {
  chunkDateRangeYmd,
  getDefaultMetricsPeriodYmd,
  resolvePrimaryAdsTimeZone,
} = require('../utils/adsTimezone');
const { useV1Reporting, getV1MaxRetentionDays, getV1ChunkDays } = require('../utils/adsV1Reporting');
const DEFAULT_METRICS_DAYS = Math.min(
  95,
  Math.max(1, parseInt(process.env.ADS_METRICS_SYNC_DAYS || '95', 10))
);
const METRICS_CHUNK_DAYS = 31;
const METRICS_THROTTLE_MS = Math.max(
  60 * 1000,
  parseInt(process.env.ADS_METRICS_SYNC_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10)
);
const REPORT_REQUEST_DELAY_MS = Math.max(
  500,
  parseInt(process.env.ADS_REPORT_REQUEST_DELAY_MS || '2500', 10)
);

/** @type {Map<string, Promise>} */
const metricsSyncLocks = new Map();

const { sleep } = require('../utils/async');

const REPORT_CONFIGS = {
  'Sponsored Products': {
    adProduct: 'SPONSORED_PRODUCTS',
    reportTypeId: 'spCampaigns',
    maxRetentionDays: 95,
    columns: [
      'campaignId',
      'impressions',
      'clicks',
      'cost',
      'purchases14d',
      'sales14d',
      'clickThroughRate',
      'costPerClick',
      'acosClicks14d',
      'roasClicks14d',
    ],
  },
  'Sponsored Brands': {
    adProduct: 'SPONSORED_BRANDS',
    reportTypeId: 'sbCampaigns',
    maxRetentionDays: 95,
    columns: [
      'campaignId',
      'impressions',
      'clicks',
      'cost',
      'purchases',
      'sales',
      'brandedSearches',
    ],
  },
  'Sponsored Display': {
    adProduct: 'SPONSORED_DISPLAY',
    reportTypeId: 'sdCampaigns',
    maxRetentionDays: 65,
    columns: ['campaignId', 'impressions', 'clicks', 'cost', 'purchases', 'sales'],
  },
};

function clampChunksToRetention(chunks, maxRetentionDays, timeZone = 'UTC') {
  const effectiveRetention = useV1Reporting() ? getV1MaxRetentionDays() : maxRetentionDays;
  const { startYmd: minDate } = getDefaultMetricsPeriodYmd(timeZone, effectiveRetention);
  return chunks
    .map((chunk) => ({
      start: chunk.start < minDate ? minDate : chunk.start,
      end: chunk.end,
    }))
    .filter((chunk) => chunk.start <= chunk.end);
}

function getMetricsChunkDays() {
  return useV1Reporting() ? getV1ChunkDays() : METRICS_CHUNK_DAYS;
}

function chunkDateRange(startYmd, endYmd, maxDays = getMetricsChunkDays()) {
  return chunkDateRangeYmd(startYmd, endYmd, maxDays);
}

async function getLifetimeMetricsPeriodForUser(user, profiles = []) {
  const timeZone = resolvePrimaryAdsTimeZone(profiles, user);
  const maxDays = useV1Reporting() ? getV1MaxRetentionDays() : DEFAULT_METRICS_DAYS;
  const { startYmd: retentionStart, endYmd } = getDefaultMetricsPeriodYmd(timeZone, maxDays);

  const earliest = await Ad.findOne({
    sellerId: user._id,
    startDate: { $exists: true, $ne: null },
  })
    .sort({ startDate: 1 })
    .select('startDate')
    .lean();

  let startYmd = retentionStart;
  if (earliest?.startDate) {
    const campaignStart = new Date(earliest.startDate).toISOString().slice(0, 10);
    startYmd = campaignStart > retentionStart ? campaignStart : retentionStart;
  }

  return { startYmd, endYmd, timeZone, maxDays };
}

function getMetricsPeriodForUser(user, profiles = [], days = DEFAULT_METRICS_DAYS) {
  const timeZone = resolvePrimaryAdsTimeZone(profiles, user);
  const effectiveDays = useV1Reporting() ? getV1MaxRetentionDays() : days;
  return getDefaultMetricsPeriodYmd(timeZone, effectiveDays);
}
function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getCampaignIdFromRow(row) {
  const raw = row.campaignId ?? row.campaign_id ?? row.campaignID;
  if (raw === undefined || raw === null || raw === '') return null;
  return String(raw);
}

function mergeMetricRow(existing, row) {
  return {
    impressions: existing.impressions + toNumber(row.impressions),
    clicks: existing.clicks + toNumber(row.clicks),
    cost: existing.cost + toNumber(row.cost),
    purchases:
      existing.purchases +
      toNumber(row.purchases14d ?? row.purchases30d ?? row.purchases ?? row.attributedConversions14d),
    sales:
      existing.sales +
      toNumber(row.sales14d ?? row.sales30d ?? row.sales ?? row.attributedSales14d),
  };
}

function buildMetricsDocument(metrics, currencyCode, startDate, endDate) {
  const impressions = metrics.impressions;
  const clicks = metrics.clicks;
  const cost = metrics.cost;
  const sales = metrics.sales;
  const purchases = metrics.purchases;

  return {
    impressions,
    clicks,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    spend: { amount: cost, currencyCode },
    cpc: clicks > 0 ? cost / clicks : 0,
    orders: purchases,
    sales: { amount: sales, currencyCode },
    acos: sales > 0 ? (cost / sales) * 100 : 0,
    roas: cost > 0 ? sales / cost : 0,
    metricsStartDate: new Date(startDate),
    metricsEndDate: new Date(endDate),
    lastSynced: new Date(),
  };
}

/**
 * Fetch and merge campaign performance for the last N days (default 90).
 */
async function syncCampaignMetricsForUser(user, options = {}) {
  const userId = String(user._id);

  if (metricsSyncLocks.has(userId)) {
    return metricsSyncLocks.get(userId);
  }

  const syncPromise = syncCampaignMetricsForUserInternal(user, options).finally(() => {
    metricsSyncLocks.delete(userId);
  });

  metricsSyncLocks.set(userId, syncPromise);
  return syncPromise;
}

async function syncCampaignMetricsForUserInternal(user, options = {}) {
  const days = Math.min(95, Math.max(1, options.days || DEFAULT_METRICS_DAYS));
  const force = options.force === true;

  if (!user.amazonAdsRefreshToken) {
    const error = new Error('Amazon Ads is not connected.');
    error.code = 'ADS_NOT_CONNECTED';
    throw error;
  }

  if (!force && user.lastAdsMetricsSyncedAt) {
    const elapsed = Date.now() - new Date(user.lastAdsMetricsSyncedAt).getTime();
    if (elapsed < METRICS_THROTTLE_MS) {
      return {
        skipped: true,
        reason: 'throttled',
        lastSyncAt: user.lastAdsMetricsSyncedAt.toISOString(),
        message: 'Performance metrics were synced recently; skipping until throttle window expires.',
      };
    }
  }

  const { queueMetricsReportsForUser } = require('./adsReportQueueService');
  const result = await queueMetricsReportsForUser(user, { days, force });

  if (result.skipped) {
    return {
      ...result,
      campaignsUpdated: 0,
      reportsRequested: 0,
      reportErrors: 0,
    };
  }

  return {
    ...result,
    campaignsUpdated: result.campaignsRebuilt || 0,
    reportsRequested: result.reportsQueued,
    reportErrors: result.queueErrors,
    skipped: false,
    metricsSyncing: result.reportsQueued > 0,
  };
}

module.exports = {
  syncCampaignMetricsForUser,
  DEFAULT_METRICS_DAYS,
  METRICS_THROTTLE_MS,
  METRICS_CHUNK_DAYS,
  REPORT_REQUEST_DELAY_MS,
  chunkDateRange,
  clampChunksToRetention,
  getMetricsPeriodForUser,
  getLifetimeMetricsPeriodForUser,
  getMetricsChunkDays,
  REPORT_CONFIGS,
};