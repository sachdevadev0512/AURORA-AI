const Ad = require('../models/Ad');
const AdMetricsDaily = require('../models/AdMetricsDaily');
const {
  getDefaultMetricsPeriodYmd,
  parseMetricsDateQuery,
  resolvePrimaryAdsTimeZone,
} = require('../utils/adsTimezone');
const { DEFAULT_METRICS_DAYS } = require('./adsReportService');

const ATTRIBUTION_BY_CAMPAIGN_TYPE = {
  'Sponsored Products': '14-day',
  'Sponsored Brands': '14-day',
  'Sponsored Display': '14-day',
};

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getCampaignIdFromRow(row) {
  const raw = row.campaignId ?? row.campaign_id ?? row.campaignID;
  if (raw === undefined || raw === null || raw === '') return null;
  return String(raw);
}

function getDateFromRow(row) {
  const raw = row.date ?? row.reportDate ?? row.day ?? row.startDate;
  if (!raw) return null;
  const value = String(raw).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

async function upsertSummaryRowsToDaily(sellerId, profileId, campaignType, rows, chunkEndDate) {
  if (!rows?.length || !chunkEndDate) return 0;

  const datedRows = rows.map((row) => ({
    ...row,
    date: getDateFromRow(row) || chunkEndDate,
  }));

  return upsertDailyMetricsRows(sellerId, profileId, campaignType, datedRows);
}

function extractRowMetrics(row) {
  const impressions = toNumber(row.impressions);
  const clicks = toNumber(row.clicks);
  const spend = toNumber(row.cost);
  const orders = toNumber(
    row.purchases14d ?? row.purchases30d ?? row.purchases ?? row.attributedConversions14d,
  );
  const sales = toNumber(row.sales14d ?? row.sales30d ?? row.sales ?? row.attributedSales14d);

  return { impressions, clicks, spend, orders, sales };
}

function buildMetricsFromTotals(totals, currencyCode = 'USD') {
  const impressions = totals.impressions || 0;
  const clicks = totals.clicks || 0;
  const spend = totals.spend || 0;
  const sales = totals.sales || 0;
  const orders = totals.orders || 0;

  return {
    impressions,
    clicks,
    orders,
    spend: { amount: spend, currencyCode },
    sales: { amount: sales, currencyCode },
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    acos: sales > 0 ? (spend / sales) * 100 : 0,
    roas: spend > 0 ? sales / spend : 0,
  };
}

async function upsertDailyMetricsRows(sellerId, profileId, campaignType, rows) {
  if (!rows?.length) return 0;

  const ops = [];

  for (const row of rows) {
    const campaignId = getCampaignIdFromRow(row);
    const date = getDateFromRow(row);
    if (!campaignId || !date) continue;

    const metrics = extractRowMetrics(row);

    ops.push({
      updateOne: {
        filter: { sellerId, profileId, campaignId, date },
        update: {
          $set: {
            campaignType,
            impressions: metrics.impressions,
            clicks: metrics.clicks,
            orders: metrics.orders,
            spend: metrics.spend,
            sales: metrics.sales,
            currencyCode: 'USD',
            source: 'DAILY',
            lastSynced: new Date(),
          },
        },
        upsert: true,
      },
    });
  }

  if (ops.length === 0) return 0;

  const result = await AdMetricsDaily.bulkWrite(ops, { ordered: false });
  return (result.upsertedCount || 0) + (result.modifiedCount || 0);
}

async function purgeSummaryChunkDailyRows(sellerId) {
  const result = await AdMetricsDaily.deleteMany({
    sellerId,
    $or: [{ source: 'SUMMARY' }, { source: { $exists: false } }],
  });
  return result.deletedCount || 0;
}

async function aggregateCampaignMetricsForRange(sellerId, startYmd, endYmd, filters = {}) {
  const match = {
    sellerId,
    date: { $gte: startYmd, $lte: endYmd },
    source: 'DAILY',
  };

  if (filters.profileId) {
    match.profileId = String(filters.profileId);
  }

  if (filters.campaignType) {
    match.campaignType = filters.campaignType;
  }

  if (filters.campaignIds?.length) {
    match.campaignId = { $in: filters.campaignIds.map(String) };
  }

  const rows = await AdMetricsDaily.aggregate([
    { $match: match },
    {
      $group: {
        _id: { profileId: '$profileId', campaignId: '$campaignId' },
        impressions: { $sum: '$impressions' },
        clicks: { $sum: '$clicks' },
        orders: { $sum: '$orders' },
        spend: { $sum: '$spend' },
        sales: { $sum: '$sales' },
        currencyCode: { $first: '$currencyCode' },
      },
    },
  ]);

  const metricsByKey = new Map();
  for (const row of rows) {
    const key = `${row._id.profileId}:${row._id.campaignId}`;
    metricsByKey.set(key, buildMetricsFromTotals(row, row.currencyCode || 'USD'));
  }

  return metricsByKey;
}

async function aggregateStatsForRange(sellerId, startYmd, endYmd, filters = {}) {
  const match = {
    sellerId,
    date: { $gte: startYmd, $lte: endYmd },
    source: 'DAILY',
  };

  if (filters.campaignType) {
    match.campaignType = filters.campaignType;
  }

  const stats = await AdMetricsDaily.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalImpressions: { $sum: '$impressions' },
        totalClicks: { $sum: '$clicks' },
        totalOrders: { $sum: '$orders' },
        totalSpend: { $sum: '$spend' },
        totalSales: { $sum: '$sales' },
      },
    },
  ]);

  const result = stats[0] || {
    totalImpressions: 0,
    totalClicks: 0,
    totalOrders: 0,
    totalSpend: 0,
    totalSales: 0,
  };

  const totalSpend = result.totalSpend || 0;
  const totalSales = result.totalSales || 0;

  return {
    totalImpressions: result.totalImpressions || 0,
    totalClicks: result.totalClicks || 0,
    totalOrders: result.totalOrders || 0,
    totalSpend,
    totalSales,
    avgAcos: totalSales > 0 ? (totalSpend / totalSales) * 100 : 0,
    avgRoas: totalSpend > 0 ? totalSales / totalSpend : 0,
  };
}

async function rebuildAdTotalsFromDaily(sellerId, startYmd, endYmd) {
  const metricsByKey = await aggregateCampaignMetricsForRange(sellerId, startYmd, endYmd);
  let updated = 0;

  for (const [key, metrics] of metricsByKey.entries()) {
    const [profileId, campaignId] = key.split(':');
    const existing = await Ad.findOne({ sellerId, profileId, campaignId })
      .select('lifetimeSource')
      .lean();
    if (existing?.lifetimeSource === 'seller_central') continue;

    const result = await Ad.updateOne(
      { sellerId, profileId, campaignId },
      {
        $set: {
          impressions: metrics.impressions,
          clicks: metrics.clicks,
          orders: metrics.orders,
          spend: metrics.spend,
          sales: metrics.sales,
          ctr: metrics.ctr,
          cpc: metrics.cpc,
          acos: metrics.acos,
          roas: metrics.roas,
          lifetimeImpressions: metrics.impressions,
          lifetimeClicks: metrics.clicks,
          lifetimeOrders: metrics.orders,
          lifetimeSpend: metrics.spend,
          lifetimeSales: metrics.sales,
          lifetimeCtr: metrics.ctr,
          lifetimeCpc: metrics.cpc,
          lifetimeAcos: metrics.acos,
          lifetimeRoas: metrics.roas,
          lifetimeSource: 'api',
          lifetimeSyncedAt: new Date(),
          metricsStartDate: new Date(`${startYmd}T00:00:00.000Z`),
          metricsEndDate: new Date(`${endYmd}T00:00:00.000Z`),
          lastSynced: new Date(),
        },
      },
    );

    if (result.matchedCount > 0) {
      updated += 1;
    }
  }

  await Ad.updateMany(
    {
      sellerId,
      $and: [
        {
          $or: [
            { metricsEndDate: { $lt: new Date(`${startYmd}T00:00:00.000Z`) } },
            { metricsStartDate: { $gt: new Date(`${endYmd}T00:00:00.000Z`) } },
          ],
        },
        {
          $or: [{ impressions: { $gt: 0 } }, { clicks: { $gt: 0 } }, { 'spend.amount': { $gt: 0 } }],
        },
      ],
    },
    {
      $set: {
        impressions: 0,
        clicks: 0,
        orders: 0,
        ctr: 0,
        cpc: 0,
        acos: 0,
        roas: 0,
        spend: { amount: 0, currencyCode: 'USD' },
        sales: { amount: 0, currencyCode: 'USD' },
        metricsStartDate: new Date(`${startYmd}T00:00:00.000Z`),
        metricsEndDate: new Date(`${endYmd}T00:00:00.000Z`),
        lastSynced: new Date(),
      },
    },
  );

  return updated;
}

function overlayMetricsOnAd(ad, metrics) {
  if (!metrics) return ad;

  const doc = ad?.toObject ? ad.toObject() : { ...ad };
  return {
    ...doc,
    impressions: metrics.impressions,
    clicks: metrics.clicks,
    orders: metrics.orders,
    spend: metrics.spend,
    sales: metrics.sales,
    ctr: metrics.ctr,
    cpc: metrics.cpc,
    acos: metrics.acos,
    roas: metrics.roas,
  };
}

function resolveMetricsPeriod(reqQuery, user, profiles = []) {
  const timeZone = resolvePrimaryAdsTimeZone(profiles, user);
  const custom = parseMetricsDateQuery(reqQuery.startDate, reqQuery.endDate, timeZone);

  if (custom) {
    return {
      ...custom,
      isLifetime: false,
      attributionWindow: '14-day (Sponsored Products); profile-specific for Brands/Display',
    };
  }

  return {
    timeZone,
    isLifetime: true,
    isCustomRange: false,
    attributionWindow: '14-day (Sponsored Products); profile-specific for Brands/Display',
  };
}

function applyLifetimeMetricsToAd(ad) {
  const doc = ad?.toObject ? ad.toObject() : { ...ad };
  const hasLifetime =
    doc.lifetimeSource === 'seller_central' ||
    toNumber(doc.lifetimeImpressions) > 0 ||
    toNumber(doc.lifetimeClicks) > 0 ||
    toNumber(doc.lifetimeSpend?.amount) > 0;
  const hasPeriod =
    toNumber(doc.impressions) > 0 ||
    toNumber(doc.clicks) > 0 ||
    toNumber(doc.spend?.amount) > 0;

  if (doc.lifetimeSource === 'seller_central' && hasLifetime) {
    return normalizeAdMetrics({
      ...doc,
      impressions: doc.lifetimeImpressions ?? 0,
      clicks: doc.lifetimeClicks ?? 0,
      orders: doc.lifetimeOrders ?? 0,
      ctr: doc.lifetimeCtr ?? 0,
      cpc: doc.lifetimeCpc ?? 0,
      acos: doc.lifetimeAcos ?? 0,
      roas: doc.lifetimeRoas ?? 0,
      spend: doc.lifetimeSpend || { amount: 0, currencyCode: 'USD' },
      sales: doc.lifetimeSales || { amount: 0, currencyCode: 'USD' },
    });
  }

  if (hasLifetime && hasPeriod) {
    const periodImpressions = toNumber(doc.impressions);
    const lifetimeImpressions = toNumber(doc.lifetimeImpressions);
    if (periodImpressions > lifetimeImpressions) {
      return normalizeAdMetrics(doc);
    }
  }

  if (hasLifetime) {
    return normalizeAdMetrics({
      ...doc,
      impressions: doc.lifetimeImpressions ?? 0,
      clicks: doc.lifetimeClicks ?? 0,
      orders: doc.lifetimeOrders ?? 0,
      ctr: doc.lifetimeCtr ?? 0,
      cpc: doc.lifetimeCpc ?? 0,
      acos: doc.lifetimeAcos ?? 0,
      roas: doc.lifetimeRoas ?? 0,
      spend: doc.lifetimeSpend || { amount: 0, currencyCode: 'USD' },
      sales: doc.lifetimeSales || { amount: 0, currencyCode: 'USD' },
    });
  }

  if (hasPeriod) {
    return normalizeAdMetrics(doc);
  }

  return normalizeAdMetrics(doc);
}

async function syncLifetimeFromPeriodMetrics(sellerId) {
  const ads = await Ad.find({
    sellerId,
    lifetimeSource: { $ne: 'seller_central' },
    $or: [
      { impressions: { $gt: 0 } },
      { clicks: { $gt: 0 } },
      { 'spend.amount': { $gt: 0 } },
    ],
  }).select('impressions clicks orders spend sales ctr cpc acos roas');

  let updated = 0;
  for (const ad of ads) {
    const result = await Ad.updateOne(
      { _id: ad._id },
      {
        $set: {
          lifetimeImpressions: ad.impressions || 0,
          lifetimeClicks: ad.clicks || 0,
          lifetimeOrders: ad.orders || 0,
          lifetimeSpend: ad.spend || { amount: 0, currencyCode: 'USD' },
          lifetimeSales: ad.sales || { amount: 0, currencyCode: 'USD' },
          lifetimeCtr: ad.ctr || 0,
          lifetimeCpc: ad.cpc || 0,
          lifetimeAcos: ad.acos || 0,
          lifetimeRoas: ad.roas || 0,
          lifetimeSyncedAt: new Date(),
        },
      },
    );
    if (result.matchedCount > 0) updated += 1;
  }

  return updated;
}

async function getLifetimeDataBounds(sellerId) {
  const dailyBounds = await AdMetricsDaily.aggregate([
    { $match: { sellerId, source: 'DAILY' } },
    {
      $group: {
        _id: null,
        dataAvailableFrom: { $min: '$date' },
        dataAvailableTo: { $max: '$date' },
      },
    },
  ]);

  if (dailyBounds[0]?.dataAvailableFrom && dailyBounds[0]?.dataAvailableTo) {
    return {
      dataAvailableFrom: dailyBounds[0].dataAvailableFrom,
      dataAvailableTo: dailyBounds[0].dataAvailableTo,
    };
  }

  const bounds = await Ad.aggregate([
    {
      $match: {
        sellerId,
        metricsStartDate: { $exists: true, $ne: null },
        metricsEndDate: { $exists: true, $ne: null },
      },
    },
    {
      $group: {
        _id: null,
        dataAvailableFrom: { $min: '$metricsStartDate' },
        dataAvailableTo: { $max: '$metricsEndDate' },
      },
    },
  ]);

  if (!bounds[0]) return null;

  const formatYmd = (value) => {
    if (!value) return null;
    return new Date(value).toISOString().slice(0, 10);
  };

  return {
    dataAvailableFrom: formatYmd(bounds[0].dataAvailableFrom),
    dataAvailableTo: formatYmd(bounds[0].dataAvailableTo),
  };
}

/**
 * A chunk is a "gap" when missing entirely, or when it has traffic but no money.
 * On Amazon every click is paid (CPC), so clicks with zero spend means the money
 * fields were dropped when the rows were stored (e.g. a report created before
 * metric.totalCost was requested). Such chunks must be re-fetched, otherwise they
 * look "covered" forever and Spend/ACOS/ROAS stay $0 even though Seller Central has
 * the data. Note: we intentionally do NOT require sales/orders to be zero — a chunk
 * can have attributed sales while spend failed to parse (the exact bug we hit).
 */
async function isIncompleteDailyChunk(match) {
  const summary = await AdMetricsDaily.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        rows: { $sum: 1 },
        clicks: { $sum: '$clicks' },
        spend: { $sum: '$spend' },
      },
    },
  ]);

  if (!summary.length || summary[0].rows === 0) {
    return true;
  }

  const { clicks, spend } = summary[0];
  if (clicks > 0 && spend === 0) {
    return true;
  }

  return false;
}

async function getDailyCoverageGaps(sellerId, startYmd, endYmd) {
  const { chunkDateRange } = require('./adsReportService');
  const chunks = chunkDateRange(startYmd, endYmd);
  const gaps = [];

  for (const chunk of chunks) {
    const incomplete = await isIncompleteDailyChunk({
      sellerId,
      source: 'DAILY',
      date: { $gte: chunk.start, $lte: chunk.end },
    });
    if (incomplete) {
      gaps.push(chunk);
    }
  }

  return gaps;
}

async function getProfileDailyCoverageGaps(sellerId, profileId, startYmd, endYmd) {
  const { chunkDateRange } = require('./adsReportService');
  const chunks = chunkDateRange(startYmd, endYmd);
  const gaps = [];

  for (const chunk of chunks) {
    const incomplete = await isIncompleteDailyChunk({
      sellerId,
      profileId: String(profileId),
      source: 'DAILY',
      date: { $gte: chunk.start, $lte: chunk.end },
    });
    if (incomplete) {
      gaps.push(chunk);
    }
  }

  return gaps;
}

async function hasDailyMetricsForRange(sellerId, startYmd, endYmd) {
  const gaps = await getDailyCoverageGaps(sellerId, startYmd, endYmd);
  return gaps.length === 0;
}

async function rebuildLifetimeFromDailyRange(sellerId, startYmd, endYmd) {
  const periodUpdated = await rebuildAdTotalsFromDaily(sellerId, startYmd, endYmd);
  const lifetimeUpdated = await syncLifetimeFromPeriodMetrics(sellerId);
  return Math.max(periodUpdated, lifetimeUpdated);
}

async function rebuildLifetimeMetrics(sellerId, startYmd, endYmd) {
  await purgeSummaryChunkDailyRows(sellerId);

  if (startYmd && endYmd) {
    return rebuildLifetimeFromDailyRange(sellerId, startYmd, endYmd);
  }

  const bounds = await getLifetimeDataBounds(sellerId);
  if (bounds?.dataAvailableFrom && bounds?.dataAvailableTo) {
    return rebuildLifetimeFromDailyRange(
      sellerId,
      bounds.dataAvailableFrom,
      bounds.dataAvailableTo,
    );
  }

  return syncLifetimeFromPeriodMetrics(sellerId);
}

function normalizeAdMetrics(doc) {
  return {
    ...doc,
    spend: {
      amount: doc.spend?.amount ?? 0,
      currencyCode: doc.spend?.currencyCode || 'USD',
    },
    sales: {
      amount: doc.sales?.amount ?? 0,
      currencyCode: doc.sales?.currencyCode || 'USD',
    },
  };
}

async function aggregateLifetimeStats(sellerId, filters = {}) {
  const match = { sellerId };
  if (filters.campaignType) {
    match.campaignType = filters.campaignType;
  }

  const stats = await Ad.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalImpressions: {
          $sum: {
            $cond: [
              { $gt: [{ $ifNull: ['$lifetimeImpressions', 0] }, 0] },
              { $ifNull: ['$lifetimeImpressions', 0] },
              { $ifNull: ['$impressions', 0] },
            ],
          },
        },
        totalClicks: {
          $sum: {
            $cond: [
              { $gt: [{ $ifNull: ['$lifetimeImpressions', 0] }, 0] },
              { $ifNull: ['$lifetimeClicks', 0] },
              { $ifNull: ['$clicks', 0] },
            ],
          },
        },
        totalOrders: {
          $sum: {
            $cond: [
              { $gt: [{ $ifNull: ['$lifetimeImpressions', 0] }, 0] },
              { $ifNull: ['$lifetimeOrders', 0] },
              { $ifNull: ['$orders', 0] },
            ],
          },
        },
        totalSpend: {
          $sum: {
            $cond: [
              { $gt: [{ $ifNull: ['$lifetimeSpend.amount', 0] }, 0] },
              { $ifNull: ['$lifetimeSpend.amount', 0] },
              { $ifNull: ['$spend.amount', 0] },
            ],
          },
        },
        totalSales: {
          $sum: {
            $cond: [
              { $gt: [{ $ifNull: ['$lifetimeSales.amount', 0] }, 0] },
              { $ifNull: ['$lifetimeSales.amount', 0] },
              { $ifNull: ['$sales.amount', 0] },
            ],
          },
        },
      },
    },
  ]);

  const result = stats[0] || {};
  const totalSpend = result.totalSpend || 0;
  const totalSales = result.totalSales || 0;

  return {
    totalImpressions: result.totalImpressions || 0,
    totalClicks: result.totalClicks || 0,
    totalOrders: result.totalOrders || 0,
    totalSpend,
    totalSales,
    avgAcos: totalSales > 0 ? (totalSpend / totalSales) * 100 : 0,
    avgRoas: totalSpend > 0 ? totalSales / totalSpend : 0,
  };
}

function formatMetricsPeriodResponse(metricsPeriod, dataBounds = null, lifetimeTarget = null) {
  if (metricsPeriod.isLifetime) {
    const loadedFrom = dataBounds?.dataAvailableFrom || null;
    const loadedTo = dataBounds?.dataAvailableTo || null;
    const targetFrom = lifetimeTarget?.startYmd || null;
    const targetTo = lifetimeTarget?.endYmd || null;
    const isPartialLifetime = Boolean(
      loadedFrom && targetFrom && loadedFrom > targetFrom,
    );

    let retentionNote =
      'Lifetime totals are rebuilt from v1 unified reporting daily data (up to ~15 months). Click Sync metrics to refresh.';
    if (isPartialLifetime) {
      retentionNote = `Partial lifetime only (${loadedFrom} → ${loadedTo}). Full range target is ${targetFrom} → ${targetTo}. Older history backfills automatically in the background — numbers will increase over the next sync cycles.`;
    } else if (loadedFrom && loadedTo) {
      retentionNote = `Lifetime data loaded (${loadedFrom} → ${loadedTo}). Click Sync metrics to refresh.`;
    }

    return {
      isLifetime: true,
      isCustomRange: false,
      isPartialLifetime,
      timeZone: metricsPeriod.timeZone,
      attributionWindow: metricsPeriod.attributionWindow,
      label: isPartialLifetime ? 'Partial lifetime' : 'Lifetime',
      lifetimeSource: 'api',
      dataAvailableFrom: loadedFrom,
      dataAvailableTo: loadedTo,
      lifetimeTargetFrom: targetFrom,
      lifetimeTargetTo: targetTo,
      retentionNote,
    };
  }

  const availableFrom = dataBounds?.dataAvailableFrom || null;
  const availableTo = dataBounds?.dataAvailableTo || null;
  const outsideAvailableData = Boolean(
    availableFrom &&
      availableTo &&
      (metricsPeriod.endYmd < availableFrom || metricsPeriod.startYmd > availableTo),
  );

  return {
    startDate: metricsPeriod.startYmd,
    endDate: metricsPeriod.endYmd,
    timeZone: metricsPeriod.timeZone,
    isCustomRange: metricsPeriod.isCustomRange,
    isLifetime: false,
    attributionWindow: metricsPeriod.attributionWindow,
    label: metricsPeriod.isCustomRange ? 'Custom range' : 'Date range',
    dataAvailableFrom: availableFrom,
    dataAvailableTo: availableTo,
    outsideAvailableData,
  };
}

function sortAdsWithMetrics(ads, sortBy, sortOrder) {
  const direction = sortOrder === 'desc' ? -1 : 1;
  const fieldMap = {
    campaignName: (ad) => String(ad.campaignName || '').toLowerCase(),
    status: (ad) => String(ad.status || '').toLowerCase(),
    campaignType: (ad) => String(ad.campaignType || '').toLowerCase(),
    startDate: (ad) => (ad.startDate ? new Date(ad.startDate).getTime() : 0),
    endDate: (ad) => (ad.endDate ? new Date(ad.endDate).getTime() : 0),
    lastSynced: (ad) => (ad.lastSynced ? new Date(ad.lastSynced).getTime() : 0),
    'budget.amount': (ad) => toNumber(ad.budget?.amount),
    'spend.amount': (ad) => toNumber(ad.spend?.amount),
    impressions: (ad) => toNumber(ad.impressions),
    clicks: (ad) => toNumber(ad.clicks),
    orders: (ad) => toNumber(ad.orders),
    acos: (ad) => toNumber(ad.acos),
    roas: (ad) => toNumber(ad.roas),
    sales: (ad) => toNumber(ad.sales?.amount),
    spend: (ad) => toNumber(ad.spend?.amount),
  };

  const getter = fieldMap[sortBy] || fieldMap.campaignName;

  return [...ads].sort((a, b) => {
    const av = getter(a);
    const bv = getter(b);
    if (av < bv) return -1 * direction;
    if (av > bv) return 1 * direction;
    return 0;
  });
}

function paginateArray(items, page, limit) {
  const skip = (page - 1) * limit;
  return {
    items: items.slice(skip, skip + limit),
    total: items.length,
    pages: Math.ceil(items.length / limit) || 0,
  };
}

module.exports = {
  ATTRIBUTION_BY_CAMPAIGN_TYPE,
  extractRowMetrics,
  getCampaignIdFromRow,
  getDateFromRow,
  upsertDailyMetricsRows,
  upsertSummaryRowsToDaily,
  aggregateCampaignMetricsForRange,
  aggregateStatsForRange,
  rebuildAdTotalsFromDaily,
  rebuildLifetimeMetrics,
  rebuildLifetimeFromDailyRange,
  getDailyCoverageGaps,
  getProfileDailyCoverageGaps,
  hasDailyMetricsForRange,
  syncLifetimeFromPeriodMetrics,
  purgeSummaryChunkDailyRows,
  getLifetimeDataBounds,
  overlayMetricsOnAd,
  applyLifetimeMetricsToAd,
  normalizeAdMetrics,
  aggregateLifetimeStats,
  formatMetricsPeriodResponse,
  buildMetricsFromTotals,
  resolveMetricsPeriod,
  sortAdsWithMetrics,
  paginateArray,
};
