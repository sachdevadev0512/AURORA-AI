const { randomUUID } = require('crypto');
const Ad = require('../models/Ad');
const AdReportJob = require('../models/AdReportJob');
const User = require('../models/User');
const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const {
  REPORT_CONFIGS,
  REPORT_REQUEST_DELAY_MS,
  chunkDateRange,
  clampChunksToRetention,
  getMetricsPeriodForUser,
  getLifetimeMetricsPeriodForUser,
} = require('./adsReportService');
const {
  useV1Reporting,
  getV1RequestDelayMs,
  getV1MaxReportsPerSync,
  isV1RateLimitCooldownActive,
  getV1RateLimitCooldownRemainingMs,
  resolveAdsAccountId,
  createV1DailyCampaignReport,
  retrieveV1Reports,
  normalizeV1ReportStatus,
  extractV1DownloadUrls,
  downloadV1ReportRows,
} = require('../utils/adsV1Reporting');
const {
  upsertDailyMetricsRows,
  rebuildLifetimeFromDailyRange,
  purgeSummaryChunkDailyRows,
  getProfileDailyCoverageGaps,
} = require('./adsMetricsService');

/** @type {Map<string, NodeJS.Timeout>} */
const aggressivePollTimers = new Map();

/** @type {Map<string, string>} */
const adsAccountIdCache = new Map();

/** @type {Promise<unknown>} */
let metricsQueueChain = Promise.resolve();

function enqueueMetricsQueueWork(work) {
  const result = metricsQueueChain.then(work);
  metricsQueueChain = result.catch(() => {});
  return result;
}

const { sleep } = require('../utils/async');
const { emitToUser } = require('../utils/socketEmit');

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getCampaignIdFromRow(row) {
  const raw = row.campaignId ?? row.campaign_id ?? row.campaignID;
  if (raw === undefined || raw === null || raw === '') return null;
  return String(raw);
}

async function resetAllMetricsForSeller(sellerId, metricsStartDate, metricsEndDate) {
  const metricsSet = {
    impressions: 0,
    clicks: 0,
    orders: 0,
    ctr: 0,
    cpc: 0,
    acos: 0,
    roas: 0,
    spend: { amount: 0, currencyCode: 'USD' },
    sales: { amount: 0, currencyCode: 'USD' },
    lastSynced: new Date(),
  };

  if (metricsStartDate) {
    metricsSet.metricsStartDate = new Date(metricsStartDate);
  }
  if (metricsEndDate) {
    metricsSet.metricsEndDate = new Date(metricsEndDate);
  }

  await Ad.updateMany({ sellerId }, { $set: metricsSet });
}

async function ensureBatchMetricsReset(sellerId, batchId) {
  const resetMarker = await AdReportJob.findOneAndUpdate(
    { batchId, metricsResetDone: { $ne: true } },
    { $set: { metricsResetDone: true } },
    { sort: { createdAt: 1 }, new: true }
  );

  if (!resetMarker) return false;

  await resetAllMetricsForSeller(
    sellerId,
    resetMarker.batchMetricsStart,
    resetMarker.batchMetricsEnd
  );
  console.log(`[AdsReportQueue] Reset metrics for batch ${batchId} before applying report data`);
  return true;
}

async function repairMissingMoneyAmounts(sellerId) {
  const broken = await Ad.find({
    sellerId,
    impressions: { $gt: 0 },
    $or: [
      { 'spend.amount': { $exists: false } },
      { 'spend.amount': null },
      { 'sales.amount': { $exists: false } },
      { 'sales.amount': null },
    ],
  }).select('_id cpc clicks acos roas spend sales');

  if (broken.length === 0) return 0;

  let repaired = 0;
  for (const ad of broken) {
    const clicks = toNumber(ad.clicks);
    const cpc = toNumber(ad.cpc);
    const spendAmount =
      cpc > 0 && clicks > 0 ? cpc * clicks : toNumber(ad.spend?.amount);

    let salesAmount = toNumber(ad.sales?.amount);
    if (spendAmount > 0) {
      if (toNumber(ad.acos) > 0) {
        salesAmount = spendAmount / (toNumber(ad.acos) / 100);
      } else if (toNumber(ad.roas) > 0) {
        salesAmount = spendAmount * toNumber(ad.roas);
      }
    }

    await Ad.updateOne(
      { _id: ad._id },
      {
        $set: {
          'spend.amount': spendAmount,
          'spend.currencyCode': ad.spend?.currencyCode || 'USD',
          'sales.amount': salesAmount,
          'sales.currencyCode': ad.sales?.currencyCode || 'USD',
        },
      }
    );
    repaired += 1;
  }

  return repaired;
}

async function applyReportRowsToAds(
  sellerId,
  profileId,
  rows,
  metricsStartDate,
  metricsEndDate,
  batchId,
) {
  const shouldResetBatch = Boolean(batchId);
  if (shouldResetBatch) {
    await ensureBatchMetricsReset(sellerId, batchId);
  }

  let updated = 0;

  for (const row of rows) {
    const campaignId = getCampaignIdFromRow(row);
    if (!campaignId) continue;

    const rowImpressions = toNumber(row.impressions);
    const rowClicks = toNumber(row.clicks);
    const rowCost = toNumber(row.cost);
    const rowPurchases = toNumber(
      row.purchases14d ?? row.purchases30d ?? row.purchases ?? row.attributedConversions14d,
    );
    const rowSales = toNumber(row.sales14d ?? row.sales30d ?? row.sales ?? row.attributedSales14d);

    const filter = { sellerId, profileId, campaignId };
    const existingAd = await Ad.findOne(filter).select('lifetimeSource').lean();
    if (existingAd?.lifetimeSource === 'seller_central') continue;

    let totalImpressions = rowImpressions;
    let totalClicks = rowClicks;
    let totalOrders = rowPurchases;
    let totalCost = rowCost;
    let totalSales = rowSales;

    if (shouldResetBatch) {
      const existing = await Ad.findOne(filter)
        .select('impressions clicks orders spend sales')
        .lean();

      totalImpressions = toNumber(existing?.impressions) + rowImpressions;
      totalClicks = toNumber(existing?.clicks) + rowClicks;
      totalOrders = toNumber(existing?.orders) + rowPurchases;
      totalCost = toNumber(existing?.spend?.amount) + rowCost;
      totalSales = toNumber(existing?.sales?.amount) + rowSales;
    }

    const metricsSet = {
      impressions: totalImpressions,
      clicks: totalClicks,
      orders: totalOrders,
      spend: { amount: totalCost, currencyCode: 'USD' },
      sales: { amount: totalSales, currencyCode: 'USD' },
      ctr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
      cpc: totalClicks > 0 ? totalCost / totalClicks : 0,
      acos: totalSales > 0 ? (totalCost / totalSales) * 100 : 0,
      roas: totalCost > 0 ? totalSales / totalCost : 0,
      lastSynced: new Date(),
    };

    if (metricsStartDate) {
      metricsSet.metricsStartDate = new Date(`${metricsStartDate}T00:00:00.000Z`);
    }
    if (metricsEndDate) {
      metricsSet.metricsEndDate = new Date(`${metricsEndDate}T00:00:00.000Z`);
    }

    const result = await Ad.updateOne(filter, { $set: metricsSet });
    if (result.matchedCount > 0) {
      updated += 1;
    }
  }

  return updated;
}

async function finalizeBatchIfDone(batchId, sellerId) {
  const pending = await AdReportJob.countDocuments({
    batchId,
    status: { $in: ['PENDING', 'PROCESSING'] },
  });
  if (pending > 0) return;

  const jobs = await AdReportJob.find({ batchId });
  const failedJobs = jobs.filter((j) => j.status === 'FAILED');
  const completed = jobs.filter((j) => j.status === 'COMPLETED').length;
  const batchMarker = jobs.find((j) => j.batchMetricsStart && j.batchMetricsEnd);
  const metricsStartDate = batchMarker?.batchMetricsStart;
  const metricsEndDate = batchMarker?.batchMetricsEnd;
  const isCustomRange = batchMarker?.isCustomRange === true;

  let campaignsWithData = 0;
  if (metricsStartDate && metricsEndDate) {
    await purgeSummaryChunkDailyRows(sellerId);

    if (!isCustomRange) {
      const { rebuildLifetimeFromAllStoredDaily } = require('./adsAutomatedLifetimeService');
      campaignsWithData = await rebuildLifetimeFromAllStoredDaily(sellerId);
    } else {
      const AdMetricsDaily = require('../models/AdMetricsDaily');
      campaignsWithData = await AdMetricsDaily.distinct('campaignId', {
        sellerId,
        source: 'DAILY',
        date: { $gte: metricsStartDate, $lte: metricsEndDate },
      }).then((ids) => ids.length);
    }

    if (campaignsWithData === 0) {
      campaignsWithData = await Ad.countDocuments({
        sellerId,
        $or: [
          { lifetimeImpressions: { $gt: 0 } },
          { impressions: { $gt: 0 } },
          { clicks: { $gt: 0 } },
          { 'spend.amount': { $gt: 0 } },
        ],
      });
    }
  } else {
    campaignsWithData = await Ad.countDocuments({
      sellerId,
      $or: [{ impressions: { $gt: 0 } }, { clicks: { $gt: 0 } }, { 'spend.amount': { $gt: 0 } }],
    });
  }

  const reportErrors = failedJobs.map((job) => ({
    profileId: job.profileId,
    campaignType: job.campaignType,
    startDate: job.startDate,
    endDate: job.endDate,
    error: job.error || 'Report failed',
  }));

  if (reportErrors.length > 0) {
    console.warn(
      `[AdsReportQueue] Batch ${batchId} completed with ${reportErrors.length} failed report(s)`,
      reportErrors,
    );
  }

  await User.findByIdAndUpdate(sellerId, {
    lastAdsMetricsSyncedAt: new Date(),
  });

  emitToUser(String(sellerId), 'adsSyncComplete', {
    event: 'ADS_METRICS_SYNC_COMPLETE',
    source: 'report_queue',
    message: `Performance metrics ready (${campaignsWithData} campaign(s) with data${failedJobs.length ? `, ${failedJobs.length} report(s) failed` : ''})`,
    campaignsUpdated: campaignsWithData,
    reportErrors: failedJobs.length,
    reportErrorDetails: reportErrors,
    reportsCompleted: completed,
    metricsStartDate,
    metricsEndDate,
  });

  await AdReportJob.deleteMany({
    batchId,
    status: { $in: ['COMPLETED', 'FAILED'] },
    completedAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });

  if (!isCustomRange) {
    void maybeContinueLifetimeBackfill(sellerId).catch((error) => {
      console.warn(`[AdsReportQueue] Auto-continue backfill failed for ${sellerId}:`, error.message);
    });
  }
}

async function maybeContinueLifetimeBackfill(sellerId) {
  if (!useV1Reporting() || isV1RateLimitCooldownActive()) {
    return null;
  }

  const inFlight = await AdReportJob.countDocuments({
    sellerId,
    status: { $in: ['PENDING', 'PROCESSING'] },
  });
  if (inFlight > 0) {
    return null;
  }

  const user = await User.findById(sellerId);
  if (!user?.amazonAdsRefreshToken) {
    return null;
  }

  const sellerAppCredentials = await getSellerAppCredentials(user._id);
  const amazonAPI = new AmazonAPI(user, sellerAppCredentials);
  const accessToken = await amazonAPI.getAdvertisingAccessToken();
  const allProfiles = await amazonAPI.getLinkedAdvertisingProfiles(accessToken);
  const activeProfileIds = await Ad.distinct('profileId', { sellerId });
  const profileIdSet = new Set(activeProfileIds.map(String));
  const profiles = allProfiles.filter((p) => profileIdSet.has(String(p.profileId)));
  const metricsPeriod = await getLifetimeMetricsPeriodForUser(user, profiles);

  let totalGaps = 0;
  for (const profile of profiles) {
    const gaps = await getProfileDailyCoverageGaps(
      sellerId,
      String(profile.profileId),
      metricsPeriod.startYmd,
      metricsPeriod.endYmd,
    );
    totalGaps += gaps.length;
  }

  if (totalGaps === 0) {
    return null;
  }

  console.log(
    `[AdsReportQueue] Auto-continuing lifetime backfill for ${sellerId} (${totalGaps} gap chunk(s) remaining)`,
  );

  return queueMetricsReportsForUser(user, { force: false });
}

async function claimReportJob(jobId) {
  return AdReportJob.findOneAndUpdate(
    { _id: jobId, status: 'PENDING' },
    { $set: { status: 'PROCESSING', processingStartedAt: new Date() } },
    { new: true }
  );
}

async function upsertV1DailyRows(sellerId, profileId, rows) {
  if (!rows?.length) return 0;

  const ads = await Ad.find({ sellerId, profileId })
    .select('campaignId campaignType')
    .lean();
  const typeByCampaign = new Map(
    ads.map((ad) => [String(ad.campaignId), ad.campaignType || 'Sponsored Products']),
  );

  const grouped = new Map();
  for (const row of rows) {
    const campaignId = getCampaignIdFromRow(row);
    if (!campaignId) continue;
    const campaignType = typeByCampaign.get(campaignId) || 'Sponsored Products';
    if (!grouped.has(campaignType)) grouped.set(campaignType, []);
    grouped.get(campaignType).push(row);
  }

  let updated = 0;
  for (const [campaignType, typeRows] of grouped.entries()) {
    updated += await upsertDailyMetricsRows(sellerId, profileId, campaignType, typeRows);
  }

  return updated;
}

async function getAdsAccountIdForProfile(amazonAPI, accessToken, profileId) {
  const cacheKey = `${amazonAPI.getAdvertisingClientId()}:${profileId}`;
  if (adsAccountIdCache.has(cacheKey)) {
    return adsAccountIdCache.get(cacheKey);
  }

  const adsAccountId = await resolveAdsAccountId(
    accessToken,
    amazonAPI.getAdvertisingClientId(),
    amazonAPI.getAdvertisingApiBaseUrl(),
    profileId,
  );

  if (adsAccountId) {
    adsAccountIdCache.set(cacheKey, adsAccountId);
  }

  return adsAccountId;
}

async function processV1ReportJob(job, accessToken, amazonAPI) {
  const reports = await retrieveV1Reports(
    accessToken,
    amazonAPI.getAdvertisingClientId(),
    amazonAPI.getAdvertisingApiBaseUrl(),
    job.adsAccountId,
    job.profileId,
    [job.reportId],
  );
  const report = reports[0];
  if (!report) {
    await AdReportJob.findByIdAndUpdate(job._id, { status: 'PENDING' });
    return false;
  }

  const status = normalizeV1ReportStatus(report);
  const hasParts = Array.isArray(report.completedReportParts) && report.completedReportParts.length > 0;

  if (status === 'PENDING' || status === 'PROCESSING' || status === 'IN_PROGRESS') {
    const ageMs = Date.now() - new Date(job.createdAt).getTime();
    if (ageMs > 3 * 60 * 60 * 1000) {
      await AdReportJob.findByIdAndUpdate(job._id, {
        status: 'FAILED',
        error: 'V1 report timed out after 3 hours',
        completedAt: new Date(),
      });
      await finalizeBatchIfDone(job.batchId, job.sellerId);
    } else {
      await AdReportJob.findByIdAndUpdate(job._id, { status: 'PENDING' });
    }
    return false;
  }

  if (status === 'FAILED' || status === 'CANCELLED') {
    await AdReportJob.findByIdAndUpdate(job._id, {
      status: 'FAILED',
      error: report.failureReason || report.failureCode || status,
      completedAt: new Date(),
    });
    await finalizeBatchIfDone(job.batchId, job.sellerId);
    return false;
  }

  if (status !== 'COMPLETED' && !hasParts) {
    await AdReportJob.findByIdAndUpdate(job._id, { status: 'PENDING' });
    return false;
  }

  const rows = await downloadV1ReportRows(report);
  const ageMs = Date.now() - new Date(job.createdAt).getTime();
  const downloadUrls = extractV1DownloadUrls(report);

  if (rows.length === 0 && ageMs < 10 * 60 * 1000) {
    await AdReportJob.findByIdAndUpdate(job._id, { status: 'PENDING' });
    console.log(
      `[AdsReportQueue] V1 report ${job.reportId} completed with empty payload (${downloadUrls.length} part(s), age ${Math.round(ageMs / 1000)}s) — retrying (${job.profileId})`,
    );
    return false;
  }

  let updated = 0;
  if (rows.length > 0) {
    updated = await upsertV1DailyRows(job.sellerId, job.profileId, rows);
  }

  console.log(
    `[AdsReportQueue] V1 report ${job.reportId} completed: ${rows.length} row(s), ${updated} daily row(s) updated (${job.profileId})`,
  );

  await AdReportJob.findByIdAndUpdate(job._id, {
    status: 'COMPLETED',
    completedAt: new Date(),
  });
  await finalizeBatchIfDone(job.batchId, job.sellerId);
  return true;
}

async function processReportJob(job, accessToken, amazonAPI) {
  const claimed = await claimReportJob(job._id);
  if (!claimed) {
    return false;
  }
  job = claimed;

  if (job.apiVersion === 'v1') {
    try {
      return await processV1ReportJob(job, accessToken, amazonAPI);
    } catch (error) {
      console.warn(`[AdsReportQueue] V1 job ${job.reportId} error:`, error.message);
      await AdReportJob.findByIdAndUpdate(job._id, { status: 'PENDING' });
      return false;
    }
  }

  const statusPayload = await amazonAPI.getCampaignPerformanceReportStatus(
    accessToken,
    job.profileId,
    job.reportId
  );
  const status = String(statusPayload?.status || '').toUpperCase();

  if (status === 'PENDING' || status === 'PROCESSING' || status === 'IN_PROGRESS') {
    const ageMs = Date.now() - new Date(job.createdAt).getTime();
    if (ageMs > 3 * 60 * 60 * 1000) {
      await AdReportJob.findByIdAndUpdate(job._id, {
        status: 'FAILED',
        error: 'Report timed out after 3 hours',
        completedAt: new Date(),
      });
      await finalizeBatchIfDone(job.batchId, job.sellerId);
    } else {
      await AdReportJob.findByIdAndUpdate(job._id, { status: 'PENDING' });
    }
    return false;
  }

  if (status === 'FAILED' || status === 'CANCELLED') {
    await AdReportJob.findByIdAndUpdate(job._id, {
      status: 'FAILED',
      error: statusPayload.failureReason || status,
      completedAt: new Date(),
    });
    await finalizeBatchIfDone(job.batchId, job.sellerId);
    return false;
  }

  if (status !== 'COMPLETED') {
    await AdReportJob.findByIdAndUpdate(job._id, { status: 'PENDING' });
    return false;
  }

  const downloadUrl = statusPayload.url || statusPayload.location;
  if (!downloadUrl) {
    await AdReportJob.findByIdAndUpdate(job._id, {
      status: 'FAILED',
      error: 'Missing download URL',
      completedAt: new Date(),
    });
    await finalizeBatchIfDone(job.batchId, job.sellerId);
    return false;
  }

  const rows = await amazonAPI.downloadCampaignPerformanceReport(downloadUrl);
  const fileSize = Number(statusPayload.fileSize || 0);
  const ageMs = Date.now() - new Date(job.createdAt).getTime();
  const completedTooFast = ageMs < 3 * 60 * 1000 && fileSize > 0 && fileSize < 64;

  if (rows.length === 0 && completedTooFast) {
    await AdReportJob.findByIdAndUpdate(job._id, { status: 'PENDING' });
    console.log(
      `[AdsReportQueue] Report ${job.reportId} completed too fast with empty payload — retrying (${fileSize} bytes)`,
    );
    return false;
  }

  let updated = 0;
  if (rows.length > 0) {
    if (job.timeUnit === 'DAILY') {
      updated = await upsertDailyMetricsRows(
        job.sellerId,
        job.profileId,
        job.campaignType,
        rows,
      );
    } else {
      updated = await applyReportRowsToAds(
        job.sellerId,
        job.profileId,
        rows,
        job.batchMetricsStart || job.startDate,
        job.batchMetricsEnd || job.endDate,
        job.isCustomRange ? null : job.batchId,
      );
      if (!job.isCustomRange && job.batchMetricsStart && job.batchMetricsEnd) {
        await rebuildLifetimeFromDailyRange(
          job.sellerId,
          job.batchMetricsStart,
          job.batchMetricsEnd,
        );
      }
    }
  }

  console.log(
    `[AdsReportQueue] Report ${job.reportId} completed: ${rows.length} row(s), ${updated} campaign(s) updated (${job.campaignType} ${job.profileId})`
  );

  await AdReportJob.findByIdAndUpdate(job._id, {
    status: 'COMPLETED',
    completedAt: new Date(),
  });
  await finalizeBatchIfDone(job.batchId, job.sellerId);

  return true;
}

async function tryProcessReportJobSoon(job, user) {
  const sellerAppCredentials = await getSellerAppCredentials(user._id);
  const amazonAPI = new AmazonAPI(user, sellerAppCredentials);
  const accessToken = await amazonAPI.getAdvertisingAccessToken();
  const maxAttempts = parseInt(process.env.ADS_REPORT_IMMEDIATE_POLL_ATTEMPTS || '20', 10);
  const pollMs = parseInt(process.env.ADS_REPORT_IMMEDIATE_POLL_MS || '5000', 10);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const done = await processReportJob(job, accessToken, amazonAPI);
      if (done) return true;
    } catch (error) {
      console.warn(`[AdsReportQueue] Immediate poll ${job.reportId}:`, error.message);
    }
    await sleep(pollMs);
  }
  return false;
}

function startAggressivePollForSeller(sellerId, durationMs = 10 * 60 * 1000) {
  const id = String(sellerId);
  if (aggressivePollTimers.has(id)) {
    clearInterval(aggressivePollTimers.get(id));
  }

  const intervalMs = parseInt(process.env.ADS_REPORT_AGGRESSIVE_POLL_MS || '60000', 10);
  const timer = setInterval(() => {
    pollPendingReportJobs().catch((error) => {
      console.warn(`[AdsReportQueue] Aggressive poll error for ${id}:`, error.message);
    });
  }, intervalMs);

  aggressivePollTimers.set(id, timer);

  setTimeout(() => {
    clearInterval(timer);
    aggressivePollTimers.delete(id);
  }, durationMs);

  pollPendingReportJobs().catch(() => {});
}

async function pollPendingReportJobs() {
  const staleCutoff = new Date(Date.now() - 15 * 60 * 1000);
  await AdReportJob.updateMany(
    { status: 'PROCESSING', processingStartedAt: { $lt: staleCutoff } },
    { $set: { status: 'PENDING' } }
  );

  const jobs = await AdReportJob.find({ status: 'PENDING' })
    .sort({ createdAt: 1 })
    .limit(100);

  if (jobs.length === 0) return;

  const jobsBySeller = new Map();
  for (const job of jobs) {
    const key = String(job.sellerId);
    if (!jobsBySeller.has(key)) jobsBySeller.set(key, []);
    jobsBySeller.get(key).push(job);
  }

  for (const [sellerId, sellerJobs] of jobsBySeller.entries()) {
    try {
      const user = await User.findById(sellerId);
      if (!user?.amazonAdsRefreshToken) continue;

      const sellerAppCredentials = await getSellerAppCredentials(user._id);
      const amazonAPI = new AmazonAPI(user, sellerAppCredentials);
      const accessToken = await amazonAPI.getAdvertisingAccessToken();

      for (const job of sellerJobs) {
        try {
          await processReportJob(job, accessToken, amazonAPI);
        } catch (error) {
          console.warn(`[AdsReportQueue] Job ${job.reportId} error:`, error.message);
        }
      }
    } catch (error) {
      console.warn(`[AdsReportQueue] Seller ${sellerId} poll error:`, error.message);
    }
  }
}

async function queueMetricsReportsForUser(user, options = {}) {
  if (useV1Reporting()) {
    return enqueueMetricsQueueWork(() => queueMetricsReportsForUserInternal(user, options));
  }
  return queueMetricsReportsForUserInternal(user, options);
}

async function queueMetricsReportsForUserInternal(user, options = {}) {
  const days = Math.min(95, Math.max(1, options.days || 95));
  const batchId = randomUUID();
  const sellerId = user._id;
  const force = options.force === true;
  const startYmd = options.startDate;
  const endYmd = options.endDate;
  const isCustomRange = Boolean(startYmd && endYmd);
  const chunkTimeUnit = 'DAILY';
  const presetChunks = Array.isArray(options.chunks) ? options.chunks : null;
  const useV1 = useV1Reporting();

  if (useV1 && isV1RateLimitCooldownActive()) {
    const remainingMin = Math.ceil(getV1RateLimitCooldownRemainingMs() / 60000);
    return {
      skipped: true,
      reason: 'v1_rate_limited',
      reportsQueued: 0,
      queueErrors: 0,
      rateLimited: true,
      deferred: true,
      message: `Amazon Ads rate limit cooldown active. Try Sync metrics again in about ${remainingMin} minute(s).`,
    };
  }

  // User-selected custom ranges must not be starved by the always-running
  // lifetime backfill. They dedupe against their own in-flight jobs (via the
  // controller's isCustomRange guard) and filterChunksWithoutPendingJobs below,
  // so they are safe to queue even while a lifetime batch is processing.
  if (!isCustomRange) {
    const inFlight = await AdReportJob.countDocuments({
      sellerId,
      status: { $in: ['PENDING', 'PROCESSING'] },
    });
    if (inFlight > 0 && !force) {
      return {
        skipped: true,
        reason: 'reports_in_flight',
        reportsQueued: 0,
        queueErrors: 0,
        message:
          'Performance reports are still processing from a previous sync. Metrics will update automatically when ready.',
      };
    }
  }

  const sellerAppCredentials = await getSellerAppCredentials(user._id);
  const amazonAPI = new AmazonAPI(user, sellerAppCredentials);
  const accessToken = await amazonAPI.getAdvertisingAccessToken();
  const allProfiles = await amazonAPI.getLinkedAdvertisingProfiles(accessToken);

  const activeProfileIds = await Ad.distinct('profileId', { sellerId });
  const profileIdSet = new Set(activeProfileIds.map(String));
  const profiles = allProfiles.filter((p) => profileIdSet.has(String(p.profileId)));

  const metricsPeriod = isCustomRange
    ? { startYmd, endYmd, timeZone: getMetricsPeriodForUser(user, profiles, days).timeZone }
    : await getLifetimeMetricsPeriodForUser(user, profiles);
  const metricsStart = metricsPeriod.startYmd;
  const metricsEnd = metricsPeriod.endYmd;
  const timeZone = metricsPeriod.timeZone;

  const allChunks = chunkDateRange(metricsStart, metricsEnd);

  if (force) {
    await AdReportJob.deleteMany({ sellerId, status: { $in: ['PENDING', 'PROCESSING'] } });
  }

  let queued = 0;
  let queueErrors = 0;
  let rateLimited = false;
  const reportErrors = [];
  const createdJobs = [];
  const v1DelayMs = useV1Reporting() ? getV1RequestDelayMs() : REPORT_REQUEST_DELAY_MS;
  const v1MaxPerSync = getV1MaxReportsPerSync();

  async function filterChunksWithoutPendingJobs(profileId, chunks) {
    if (!chunks.length) return chunks;

    const pending = await AdReportJob.find({
      sellerId,
      profileId: String(profileId),
      status: { $in: ['PENDING', 'PROCESSING'] },
    })
      .select('startDate endDate')
      .lean();

    if (!pending.length) return chunks;

    const pendingKeys = new Set(pending.map((job) => `${job.startDate}:${job.endDate}`));
    return chunks.filter((chunk) => !pendingKeys.has(`${chunk.start}:${chunk.end}`));
  }

  async function queueV1ChunksForProfile(profile, profileId, chunksToQueue, adsAccountId) {
    for (const chunk of chunksToQueue) {
      if (rateLimited || queued >= v1MaxPerSync) {
        break;
      }

      try {
        await sleep(v1DelayMs);
        const reportId = await createV1DailyCampaignReport(
          accessToken,
          amazonAPI.getAdvertisingClientId(),
          amazonAPI.getAdvertisingApiBaseUrl(),
          adsAccountId,
          profileId,
          chunk.start,
          chunk.end,
          undefined,
          { retryOnRateLimit: false },
        );

        const existing = await AdReportJob.findOne({ reportId });
        if (existing) {
          if (existing.status === 'PENDING') {
            await AdReportJob.updateOne(
              { reportId },
              {
                $set: {
                  batchId,
                  sellerId,
                  profileId,
                  campaignType: 'Unified',
                  apiVersion: 'v1',
                  adsAccountId,
                  batchMetricsStart: metricsStart,
                  batchMetricsEnd: metricsEnd,
                  timeUnit: chunkTimeUnit,
                  isCustomRange,
                  metricsResetDone: false,
                },
              },
            );
            queued += 1;
          }
          continue;
        }

        const job = await AdReportJob.create({
          sellerId,
          batchId,
          profileId,
          campaignType: 'Unified',
          apiVersion: 'v1',
          adsAccountId,
          reportId,
          startDate: chunk.start,
          endDate: chunk.end,
          batchMetricsStart: metricsStart,
          batchMetricsEnd: metricsEnd,
          timeUnit: chunkTimeUnit,
          isCustomRange,
          metricsResetDone: false,
          status: 'PENDING',
        });
        createdJobs.push({ job, user });
        queued += 1;
      } catch (error) {
        const isRateLimit = error.code === 'ADS_V1_RATE_LIMITED' || String(error.message).includes('429');
        if (isRateLimit) {
          rateLimited = true;
          console.warn(
            `[AdsReportQueue] V1 rate limited for ${profileId}; pausing queue after ${queued} report(s). Remaining chunks will sync on the next run.`,
          );
          break;
        }

        queueErrors += 1;
        reportErrors.push({
          profileId,
          campaignType: 'Unified',
          startDate: chunk.start,
          endDate: chunk.end,
          error: (error.message || String(error)).slice(0, 300),
        });
        console.warn(
          `[AdsReportQueue] V1 queue failed ${profileId} ${chunk.start}..${chunk.end}:`,
          error.message?.slice(0, 300),
        );
      }
    }
  }

  async function queueChunksForProfile(profile, profileId, campaignTypes, chunksToQueue) {
    for (const campaignType of campaignTypes) {
      const reportConfig = REPORT_CONFIGS[campaignType];
      if (!reportConfig) continue;

      const chunks = isCustomRange
        ? chunksToQueue
        : clampChunksToRetention(chunksToQueue, reportConfig.maxRetentionDays || 95, timeZone);
      if (chunks.length === 0) continue;

      for (const chunk of chunks) {
        try {
          await sleep(REPORT_REQUEST_DELAY_MS);
          const reportId = await amazonAPI.createCampaignPerformanceReport(
            accessToken,
            profileId,
            reportConfig,
            chunk.start,
            chunk.end,
            {
              timeUnit: chunkTimeUnit,
              uniqueSuffix: `${batchId}-${chunkTimeUnit}-${chunk.start}`,
            },
          );

          const existing = await AdReportJob.findOne({ reportId });
          if (existing) {
            if (existing.status === 'PENDING') {
              await AdReportJob.updateOne(
                { reportId },
                {
                  $set: {
                    batchId,
                    sellerId,
                    profileId,
                    campaignType,
                    batchMetricsStart: metricsStart,
                    batchMetricsEnd: metricsEnd,
                    timeUnit: chunkTimeUnit,
                    isCustomRange,
                    metricsResetDone: false,
                  },
                },
              );
              queued += 1;
            }
            continue;
          }

          const job = await AdReportJob.create({
            sellerId,
            batchId,
            profileId,
            campaignType,
            reportId,
            startDate: chunk.start,
            endDate: chunk.end,
            batchMetricsStart: metricsStart,
            batchMetricsEnd: metricsEnd,
            timeUnit: chunkTimeUnit,
            isCustomRange,
            metricsResetDone: false,
            status: 'PENDING',
          });
          createdJobs.push({ job, user });
          queued += 1;
        } catch (error) {
          const msg = error.message || String(error);
          const duplicateMatch = msg.match(/duplicate of\s*:?\s*([a-f0-9-]+)/i);
          if (duplicateMatch?.[1]) {
            try {
              const reportId = duplicateMatch[1];
              const job = await AdReportJob.findOneAndUpdate(
                { reportId },
                {
                  sellerId,
                  batchId,
                  profileId,
                  campaignType,
                  reportId,
                  startDate: chunk.start,
                  endDate: chunk.end,
                  batchMetricsStart: metricsStart,
                  batchMetricsEnd: metricsEnd,
                  timeUnit: chunkTimeUnit,
                  isCustomRange,
                  metricsResetDone: false,
                  status: 'PENDING',
                },
                { upsert: true, new: true },
              );
              createdJobs.push({ job, user });
              queued += 1;
              continue;
            } catch (dupError) {
              queueErrors += 1;
              reportErrors.push({
                profileId,
                campaignType,
                startDate: chunk.start,
                endDate: chunk.end,
                error: dupError.message.slice(0, 300),
              });
              continue;
            }
          }

          queueErrors += 1;
          reportErrors.push({
            profileId,
            campaignType,
            startDate: chunk.start,
            endDate: chunk.end,
            error: msg.slice(0, 300),
          });
          console.warn(
            `[AdsReportQueue] Queue failed ${campaignType} ${profileId} ${chunk.start}..${chunk.end} (${chunkTimeUnit}):`,
            msg.slice(0, 300),
          );
        }
      }
    }
  }

  const rangeChunks = presetChunks || (isCustomRange ? chunkDateRange(metricsStart, metricsEnd) : allChunks);

  for (const profile of profiles) {
    if (useV1 && (rateLimited || queued >= v1MaxPerSync)) {
      break;
    }

    const profileId = String(profile.profileId);

    if (useV1) {
      const adsAccountId = await getAdsAccountIdForProfile(amazonAPI, accessToken, profileId);
      if (!adsAccountId) {
        queueErrors += 1;
        reportErrors.push({
          profileId,
          campaignType: 'Unified',
          error: 'Could not resolve adsAccountId for v1 reporting',
        });
        continue;
      }

      let chunks = isCustomRange
        ? rangeChunks
        : await getProfileDailyCoverageGaps(sellerId, profileId, metricsStart, metricsEnd);

      if (!isCustomRange) {
        chunks = clampChunksToRetention(chunks, 95, timeZone);
        // Backfill the most recent gaps first. With a small per-sync budget and
        // Amazon rate limits, oldest-first ordering meant recent months (what
        // users actually view) could take weeks to appear — or never arrive.
        chunks = [...chunks].sort((a, b) => (a.start < b.start ? 1 : -1));
      }

      chunks = await filterChunksWithoutPendingJobs(profileId, chunks);
      if (chunks.length === 0) continue;

      const remainingBudget = v1MaxPerSync - queued;
      await queueV1ChunksForProfile(
        profile,
        profileId,
        chunks.slice(0, remainingBudget),
        adsAccountId,
      );
      continue;
    }

    const campaignTypes = await Ad.distinct('campaignType', { sellerId, profileId });
    await queueChunksForProfile(profile, profileId, campaignTypes, rangeChunks);
  }

  for (const { job, user: jobUser } of createdJobs.slice(0, 4)) {
    void tryProcessReportJobSoon(job, jobUser).catch(() => {});
  }

  startAggressivePollForSeller(sellerId);

  let campaignsRebuilt = 0;
  if (!isCustomRange && queued === 0 && !rateLimited) {
    const { rebuildLifetimeFromAllStoredDaily } = require('./adsAutomatedLifetimeService');
    campaignsRebuilt = await rebuildLifetimeFromAllStoredDaily(sellerId);
    if (campaignsRebuilt > 0) {
      console.log(
        `[AdsReportQueue] Rebuilt lifetime metrics for ${campaignsRebuilt} campaign(s) from stored daily data (${sellerId})`,
      );
    }
  }

  if (!isCustomRange && queued === 0 && !rateLimited && useV1) {
    for (const profile of profiles) {
      if (queued >= v1MaxPerSync) break;

      const profileId = String(profile.profileId);
      const adsAccountId = await getAdsAccountIdForProfile(amazonAPI, accessToken, profileId);
      if (!adsAccountId) continue;

      let chunks = await getProfileDailyCoverageGaps(sellerId, profileId, metricsStart, metricsEnd);
      chunks = clampChunksToRetention(chunks, 95, timeZone);
      chunks = [...chunks].sort((a, b) => (a.start < b.start ? 1 : -1));
      chunks = await filterChunksWithoutPendingJobs(profileId, chunks);
      if (chunks.length === 0) continue;

      const remainingBudget = v1MaxPerSync - queued;
      await queueV1ChunksForProfile(
        profile,
        profileId,
        chunks.slice(0, remainingBudget),
        adsAccountId,
      );
    }
  }

  if (campaignsRebuilt > 0 && queued === 0) {
    emitToUser(String(sellerId), 'adsSyncComplete', {
      event: 'ADS_METRICS_SYNC_COMPLETE',
      source: 'report_queue',
      message: `Applied stored daily metrics to ${campaignsRebuilt} campaign(s).`,
      campaignsUpdated: campaignsRebuilt,
      metricsStartDate: metricsStart,
      metricsEndDate: metricsEnd,
    });
  }

  return {
    batchId,
    reportsQueued: queued,
    campaignsRebuilt,
    queueErrors,
    reportErrors,
    metricsStartDate: metricsStart,
    metricsEndDate: metricsEnd,
    timeZone,
    timeUnit: chunkTimeUnit,
    isCustomRange,
    message:
      queued > 0
        ? isCustomRange
          ? `Queued ${queued} daily report(s) for ${metricsStart} to ${metricsEnd}. Metrics will update when Amazon finishes processing.`
          : useV1
            ? rateLimited
              ? `Queued ${queued} v1 report(s) before Amazon rate limit. More history will backfill automatically on the next sync.`
              : `Queued ${queued} v1 daily report(s) (${metricsStart} → ${metricsEnd}). Backfill continues automatically in the background.`
            : `Queued ${queued} daily performance report(s) for the full available history (~${days} days). Metrics usually appear within 10–30 minutes.`
        : rateLimited
          ? 'Amazon Ads rate limit reached. Try Sync metrics again in a few minutes.'
          : campaignsRebuilt > 0
            ? `Applied stored daily metrics to ${campaignsRebuilt} campaign(s). Older lifetime history is backfilling automatically.`
            : 'No missing performance reports to queue. Existing daily data will be used for lifetime totals.',
    rateLimited,
    deferred: rateLimited || (useV1 && !isCustomRange && queued > 0),
  };
}

function startAdsReportQueuePoller() {
  const intervalMs = Math.max(
    60000,
    parseInt(process.env.ADS_REPORT_QUEUE_POLL_MS || '60000', 10)
  );

  setInterval(() => {
    pollPendingReportJobs().catch((error) => {
      console.error('[AdsReportQueue] Poll cycle failed:', error.message);
    });
  }, intervalMs);

  pollPendingReportJobs().catch(() => {});
}

module.exports = {
  queueMetricsReportsForUser,
  pollPendingReportJobs,
  startAdsReportQueuePoller,
  startAggressivePollForSeller,
  repairMissingMoneyAmounts,
  resetAllMetricsForSeller,
  applyReportRowsToAds,
};
