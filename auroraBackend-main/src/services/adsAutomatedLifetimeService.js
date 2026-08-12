const Ad = require('../models/Ad');
const AdMetricsDaily = require('../models/AdMetricsDaily');
const {
  rebuildLifetimeFromDailyRange,
  syncLifetimeFromPeriodMetrics,
  getLifetimeDataBounds,
} = require('./adsMetricsService');

async function getStoredDailyBounds(sellerId) {
  const bounds = await AdMetricsDaily.aggregate([
    { $match: { sellerId, source: 'DAILY' } },
    {
      $group: {
        _id: null,
        dataAvailableFrom: { $min: '$date' },
        dataAvailableTo: { $max: '$date' },
      },
    },
  ]);

  if (!bounds[0]?.dataAvailableFrom || !bounds[0]?.dataAvailableTo) {
    return null;
  }

  return {
    dataAvailableFrom: bounds[0].dataAvailableFrom,
    dataAvailableTo: bounds[0].dataAvailableTo,
  };
}

async function rebuildLifetimeFromAllStoredDaily(sellerId) {
  const bounds = await getStoredDailyBounds(sellerId);
  if (!bounds) {
    return syncLifetimeFromPeriodMetrics(sellerId);
  }

  return rebuildLifetimeFromDailyRange(
    sellerId,
    bounds.dataAvailableFrom,
    bounds.dataAvailableTo,
  );
}

async function syncAutomatedLifetimeForUser(user) {
  const sellerId = user._id;
  const updated = await rebuildLifetimeFromAllStoredDaily(sellerId);
  const bounds = (await getStoredDailyBounds(sellerId)) || (await getLifetimeDataBounds(sellerId));

  return {
    campaignsUpdated: updated,
    dataAvailableFrom: bounds?.dataAvailableFrom || null,
    dataAvailableTo: bounds?.dataAvailableTo || null,
    message:
      updated > 0
        ? `Lifetime metrics updated automatically for ${updated} campaign(s).`
        : 'Lifetime metrics will populate when Amazon report sync completes.',
  };
}

module.exports = {
  getStoredDailyBounds,
  rebuildLifetimeFromAllStoredDaily,
  syncAutomatedLifetimeForUser,
};
