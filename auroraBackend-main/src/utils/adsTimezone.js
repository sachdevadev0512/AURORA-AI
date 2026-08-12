const {
  resolveDashboardTimeZone,
  getDatePartsInTimeZone,
  zonedTimeToUtc,
  startOfDayInTimeZone,
  endOfDayInTimeZone,
} = require('./dashboardMetrics');

const COUNTRY_CODE_TIMEZONES = {
  US: 'America/Los_Angeles',
  CA: 'America/Toronto',
  MX: 'America/Mexico_City',
  UK: 'Europe/London',
  GB: 'Europe/London',
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  ES: 'Europe/Madrid',
  IT: 'Europe/Rome',
  IN: 'Asia/Kolkata',
  JP: 'Asia/Tokyo',
  AU: 'Australia/Sydney',
  BR: 'America/Sao_Paulo',
  NL: 'Europe/Amsterdam',
  SE: 'Europe/Stockholm',
  PL: 'Europe/Warsaw',
  BE: 'Europe/Brussels',
  TR: 'Europe/Istanbul',
  AE: 'Asia/Dubai',
  SG: 'Asia/Singapore',
};

function resolveAdsProfileTimeZone(profile = {}, user = {}) {
  const countryCode = String(profile.countryCode || profile.country || '').toUpperCase();
  if (countryCode && COUNTRY_CODE_TIMEZONES[countryCode]) {
    return COUNTRY_CODE_TIMEZONES[countryCode];
  }

  if (profile.timezone && typeof profile.timezone === 'string') {
    return profile.timezone;
  }

  return resolveDashboardTimeZone(user, {});
}

function resolvePrimaryAdsTimeZone(profiles = [], user = {}) {
  const usProfile = profiles.find((p) => String(p.countryCode || '').toUpperCase() === 'US');
  if (usProfile) {
    return resolveAdsProfileTimeZone(usProfile, user);
  }

  if (profiles[0]) {
    return resolveAdsProfileTimeZone(profiles[0], user);
  }

  return resolveDashboardTimeZone(user, {});
}

function formatYmdInTimeZone(date, timeZone) {
  const parts = getDatePartsInTimeZone(date, timeZone);
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

function parseYmdParts(ymd) {
  const match = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function addCalendarDaysYmd(ymd, days) {
  const parts = parseYmdParts(ymd);
  if (!parts) return null;

  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + days);

  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

function compareYmd(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function chunkDateRangeYmd(startYmd, endYmd, maxDays = 31) {
  const chunks = [];
  let current = startYmd;

  while (compareYmd(current, endYmd) <= 0) {
    let chunkEnd = current;
    for (let i = 1; i < maxDays; i += 1) {
      const next = addCalendarDaysYmd(chunkEnd, 1);
      if (!next || compareYmd(next, endYmd) > 0) break;
      chunkEnd = next;
    }

    chunks.push({ start: current, end: chunkEnd });
    const after = addCalendarDaysYmd(chunkEnd, 1);
    if (!after || compareYmd(after, endYmd) > 0) break;
    current = after;
  }

  return chunks;
}

function getDefaultMetricsPeriodYmd(timeZone, days = 90) {
  const now = new Date();
  const endYmd = formatYmdInTimeZone(now, timeZone);
  const startParts = getDatePartsInTimeZone(now, timeZone);
  const startAnchor = zonedTimeToUtc(
    {
      year: startParts.year,
      month: startParts.month,
      day: startParts.day,
    },
    timeZone,
  );
  const startDate = new Date(startAnchor.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const startYmd = formatYmdInTimeZone(startDate, timeZone);
  return { startYmd, endYmd, timeZone };
}

function parseMetricsDateQuery(startDate, endDate, timeZone) {
  const ymdPattern = /^\d{4}-\d{2}-\d{2}$/;

  if (!startDate && !endDate) {
    return null;
  }

  const startYmd = startDate && ymdPattern.test(String(startDate)) ? String(startDate) : null;
  const endYmd = endDate && ymdPattern.test(String(endDate)) ? String(endDate) : null;

  if (!startYmd && !endYmd) {
    return null;
  }

  const resolvedStart = startYmd || endYmd;
  const resolvedEnd = endYmd || startYmd;

  if (compareYmd(resolvedStart, resolvedEnd) > 0) {
    return {
      startYmd: resolvedEnd,
      endYmd: resolvedStart,
      timeZone,
      isCustomRange: true,
    };
  }

  return {
    startYmd: resolvedStart,
    endYmd: resolvedEnd,
    timeZone,
    isCustomRange: true,
  };
}

function ymdToUtcStart(ymd, timeZone) {
  const parts = parseYmdParts(ymd);
  if (!parts) return null;
  return startOfDayInTimeZone(zonedTimeToUtc(parts, timeZone), timeZone);
}

function ymdToUtcEnd(ymd, timeZone) {
  const parts = parseYmdParts(ymd);
  if (!parts) return null;
  return endOfDayInTimeZone(zonedTimeToUtc(parts, timeZone), timeZone);
}

function listDatesInRange(startYmd, endYmd) {
  const dates = [];
  let current = startYmd;
  while (compareYmd(current, endYmd) <= 0) {
    dates.push(current);
    const next = addCalendarDaysYmd(current, 1);
    if (!next || next === current) break;
    current = next;
  }
  return dates;
}

module.exports = {
  COUNTRY_CODE_TIMEZONES,
  resolveAdsProfileTimeZone,
  resolvePrimaryAdsTimeZone,
  formatYmdInTimeZone,
  parseYmdParts,
  addCalendarDaysYmd,
  compareYmd,
  chunkDateRangeYmd,
  getDefaultMetricsPeriodYmd,
  parseMetricsDateQuery,
  ymdToUtcStart,
  ymdToUtcEnd,
  listDatesInRange,
};
