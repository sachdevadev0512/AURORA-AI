const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const Product = require('../models/Product');
const { buildSalesTrafficReportRange } = require('../utils/salesTrafficWindow');

const DEFAULT_WINDOW_DAYS = parseInt(process.env.SALES_TRAFFIC_WINDOW_DAYS || '30', 10);
// Seller Central Business Reports typically end on yesterday (marketplace local).
const DEFAULT_LAG_DAYS = parseInt(process.env.SALES_TRAFFIC_LAG_DAYS || '1', 10);

/**
 * Fetch Amazon's Sales & Traffic Business Report and populate each product's
 * `unitsSold` and `pageViews` (aggregated per ASIN over the window).
 *
 * Best-effort: callers should treat failures as non-fatal.
 */
async function enrichSalesAndTraffic(user, { days = DEFAULT_WINDOW_DAYS, lagDays = DEFAULT_LAG_DAYS } = {}) {
  if (!user?.amazonRefreshToken) {
    return { success: false, reason: 'NOT_CONNECTED' };
  }

  const range = buildSalesTrafficReportRange(user, days, lagDays);

  const sellerAppCredentials = await getSellerAppCredentials(user._id);
  const amazonAPI = new AmazonAPI(user, sellerAppCredentials);

  const byAsin = await amazonAPI.fetchSalesAndTrafficByAsin(range.startDate, range.endDate);

  if (!byAsin || byAsin.size === 0) {
    console.warn(
      `[SalesTraffic] No ASIN rows for ${user.email || user._id} window ${range.startDate}…${range.endDate} (${range.timeZone})`,
    );
    return {
      success: true,
      updated: 0,
      asins: 0,
      window: { ...range, days },
    };
  }

  const bulkOps = [];
  for (const [asin, metrics] of byAsin.entries()) {
    bulkOps.push({
      updateMany: {
        filter: { sellerId: user._id, asin },
        update: {
          $set: {
            unitsSold: metrics.unitsSold,
            pageViews: metrics.pageViews,
          },
        },
      },
    });
  }

  let updated = 0;
  if (bulkOps.length > 0) {
    const result = await Product.bulkWrite(bulkOps, { ordered: false, runValidators: true });
    updated = result.modifiedCount || 0;
  }

  // After a successful report, treat remaining null metrics as 0 (synced, no traffic)
  // so the Products UI shows "0" instead of "—" for SKUs Amazon omitted from the report.
  const zeroViews = await Product.updateMany(
    {
      sellerId: user._id,
      $or: [{ pageViews: null }, { pageViews: { $exists: false } }],
    },
    { $set: { pageViews: 0 } },
  );
  const zeroSold = await Product.updateMany(
    {
      sellerId: user._id,
      $or: [{ unitsSold: null }, { unitsSold: { $exists: false } }],
    },
    { $set: { unitsSold: 0 } },
  );

  return {
    success: true,
    updated: updated + (zeroViews.modifiedCount || 0) + (zeroSold.modifiedCount || 0),
    asins: byAsin.size,
    window: { ...range, days },
    zeroedViews: zeroViews.modifiedCount || 0,
    zeroedSold: zeroSold.modifiedCount || 0,
  };
}

module.exports = { enrichSalesAndTraffic };
