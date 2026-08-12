const {
  resolveDashboardTimeZone,
  getDatePartsInTimeZone,
  addCalendarDays,
} = require('./dashboardMetrics');

function formatYmd(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/**
 * Build GET_SALES_AND_TRAFFIC_REPORT date boundaries aligned with Seller Central
 * "Last N days" (marketplace-local calendar dates, not UTC midnight).
 *
 * Amazon uses the date portion of dataStartTime/dataEndTime for DAY granularity.
 * For US sellers this matches Pacific calendar days in Business Reports.
 */
function buildSalesTrafficReportRange(user, days = 30, lagDays = 1, now = new Date()) {
  const parsedDays = Math.max(1, Number(days) || 30);
  const parsedLag = Math.max(0, Number(lagDays) || 0);
  const timeZone = resolveDashboardTimeZone(user, {});

  const today = getDatePartsInTimeZone(now, timeZone);
  const endParts = addCalendarDays(today, -parsedLag);
  const startParts = addCalendarDays(endParts, -(parsedDays - 1));

  const startDate = formatYmd(startParts);
  const endDate = formatYmd(endParts);

  return {
    timeZone,
    days: parsedDays,
    lagDays: parsedLag,
    startDate,
    endDate,
    // ISO copies kept for logging / API responses only.
    start: `${startDate}T00:00:00.000Z`,
    end: `${endDate}T23:59:59.999Z`,
  };
}

function aggregateSalesAndTrafficByAsin(report) {
  const byAsin = new Map();
  const rows = report?.salesAndTrafficByAsin || [];

  for (const row of rows) {
    const asin = row.childAsin || row.parentAsin || row.asin;
    if (!asin) continue;

    const sales = row.salesByAsin || {};
    const traffic = row.trafficByAsin || {};
    const unitsSold = Number(sales.unitsOrdered) || 0;
    const pageViews =
      traffic.pageViews != null
        ? Number(traffic.pageViews) || 0
        : (Number(traffic.browserPageViews) || 0) + (Number(traffic.mobileAppPageViews) || 0);

    const existing = byAsin.get(asin) || { unitsSold: 0, pageViews: 0 };
    existing.unitsSold += unitsSold;
    existing.pageViews += pageViews;
    byAsin.set(asin, existing);
  }

  return byAsin;
}

module.exports = {
  buildSalesTrafficReportRange,
  formatYmd,
  aggregateSalesAndTrafficByAsin,
};
