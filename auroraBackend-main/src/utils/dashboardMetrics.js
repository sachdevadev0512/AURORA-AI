const CANCELLED_ORDER_STATUSES = ['Canceled', 'Cancelled', 'Unfulfillable'];

const MARKETPLACE_TIMEZONES = {
  A21TJRUUN4KGV: 'Asia/Kolkata',
  ATVPDKIKX0DER: 'America/Los_Angeles',
  A2EUQ1WTGCTBG2: 'America/Toronto',
  A1AM78C64UM0Y8: 'America/Mexico_City',
  A1F83G8C2ARO7P: 'Europe/London',
  A1PA6795UKMFR9: 'Europe/Berlin',
  A1RKKUPIHCS9HS: 'Europe/Madrid',
  A13V1IB3VIYZZH: 'Europe/Paris',
  A1VC38T7YXB528: 'Asia/Tokyo',
  A39IBJ37TRP1C6: 'Australia/Sydney',
};

const SALES_CHANNEL_TIMEZONES = {
  'Amazon.com': 'America/Los_Angeles',
  'Amazon.in': 'Asia/Kolkata',
  'Amazon.ca': 'America/Toronto',
  'Amazon.com.mx': 'America/Mexico_City',
  'Amazon.co.uk': 'Europe/London',
  'Amazon.de': 'Europe/Berlin',
  'Amazon.fr': 'Europe/Paris',
  'Amazon.es': 'Europe/Madrid',
  'Amazon.it': 'Europe/Rome',
  'Amazon.co.jp': 'Asia/Tokyo',
  'Amazon.com.au': 'Australia/Sydney',
};

const REGION_FALLBACK_TIMEZONES = {
  NA: 'America/Los_Angeles',
  EU: 'Europe/London',
  FE: 'Asia/Tokyo',
};

function getDatePartsInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function zonedTimeToUtc(parts, timeZone) {
  let guess = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour || 0,
      parts.minute || 0,
      parts.second || 0,
      parts.ms || 0,
    ),
  );

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const got = getDatePartsInTimeZone(guess, timeZone);
    const desired = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour || 0,
      parts.minute || 0,
      parts.second || 0,
      parts.ms || 0,
    );
    const gotAsUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second);
    const diff = desired - gotAsUtc;
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }

  return guess;
}

function startOfDayInTimeZone(date, timeZone) {
  const parts = getDatePartsInTimeZone(date, timeZone);
  return zonedTimeToUtc({ year: parts.year, month: parts.month, day: parts.day }, timeZone);
}

function endOfDayInTimeZone(date, timeZone) {
  const dayStart = startOfDayInTimeZone(date, timeZone);
  const nextDayStart = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  let end = new Date(nextDayStart.getTime() - 1);

  // Correct for DST transitions where 24h offset is wrong.
  const endParts = getDatePartsInTimeZone(end, timeZone);
  const startParts = getDatePartsInTimeZone(dayStart, timeZone);
  if (endParts.day !== startParts.day) {
    end = new Date(zonedTimeToUtc(
      { year: startParts.year, month: startParts.month, day: startParts.day, hour: 23, minute: 59, second: 59, ms: 999 },
      timeZone,
    ).getTime());
  }

  return end;
}

function addCalendarDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + days);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/**
 * Resolve the timezone Amazon Seller Central would use to display a single order.
 * Seller Central shows each order in its marketplace's local timezone, so we
 * derive it from the order's own marketplace/sales-channel first, then fall back
 * to the seller-level timezone.
 */
function resolveOrderTimeZone(order = {}, fallbackTimeZone = 'UTC') {
  if (order.marketplaceId && MARKETPLACE_TIMEZONES[order.marketplaceId]) {
    return MARKETPLACE_TIMEZONES[order.marketplaceId];
  }

  const channel = order.salesChannel || order.marketplaceName;
  if (channel && SALES_CHANNEL_TIMEZONES[channel]) {
    return SALES_CHANNEL_TIMEZONES[channel];
  }

  return fallbackTimeZone || 'UTC';
}

function resolveDashboardTimeZone(user = {}, query = {}, topSalesChannel = null) {
  if (query.timeZone && typeof query.timeZone === 'string') {
    return query.timeZone;
  }

  if (topSalesChannel && SALES_CHANNEL_TIMEZONES[topSalesChannel]) {
    return SALES_CHANNEL_TIMEZONES[topSalesChannel];
  }

  const preferredMarketplaces = ['ATVPDKIKX0DER', 'A21TJRUUN4KGV', 'A1F83G8C2ARO7P', 'A2EUQ1WTGCTBG2'];
  for (const marketplaceId of preferredMarketplaces) {
    if ((user.amazonMarketplaceIds || []).includes(marketplaceId) && MARKETPLACE_TIMEZONES[marketplaceId]) {
      return MARKETPLACE_TIMEZONES[marketplaceId];
    }
  }

  for (const marketplaceId of user.amazonMarketplaceIds || []) {
    if (MARKETPLACE_TIMEZONES[marketplaceId]) {
      return MARKETPLACE_TIMEZONES[marketplaceId];
    }
  }

  // Never fall back to UTC for known selling regions — that shifts day
  // boundaries vs Seller Central (e.g. NA must stay America/Los_Angeles).
  return REGION_FALLBACK_TIMEZONES[user.marketplace] || REGION_FALLBACK_TIMEZONES.NA;
}

function buildPresetPeriods(now = new Date(), timeZone = 'UTC') {
  const todayStart = startOfDayInTimeZone(now, timeZone);
  const yesterdayEnd = new Date(todayStart.getTime() - 1);
  const yesterdayStart = startOfDayInTimeZone(yesterdayEnd, timeZone);

  const dayBeforeYesterdayEnd = new Date(yesterdayStart.getTime() - 1);
  const dayBeforeYesterdayStart = startOfDayInTimeZone(dayBeforeYesterdayEnd, timeZone);

  const todayParts = getDatePartsInTimeZone(now, timeZone);
  const monthStart = zonedTimeToUtc(
    { year: todayParts.year, month: todayParts.month, day: 1 },
    timeZone,
  );
  const lastMonthEnd = new Date(monthStart.getTime() - 1);
  const lastMonthParts = getDatePartsInTimeZone(lastMonthEnd, timeZone);
  const lastMonthStart = zonedTimeToUtc(
    { year: lastMonthParts.year, month: lastMonthParts.month, day: 1 },
    timeZone,
  );

  const twoMonthsAgoEnd = new Date(lastMonthStart.getTime() - 1);
  const twoMonthsAgoParts = getDatePartsInTimeZone(twoMonthsAgoEnd, timeZone);
  const twoMonthsAgoStart = zonedTimeToUtc(
    { year: twoMonthsAgoParts.year, month: twoMonthsAgoParts.month, day: 1 },
    timeZone,
  );

  const daysInMonth = new Date(todayParts.year, todayParts.month, 0).getDate();
  const dayOfMonth = todayParts.day;
  const lastMonthDays = new Date(lastMonthParts.year, lastMonthParts.month, 0).getDate();
  const compareDay = Math.min(dayOfMonth, lastMonthDays);
  const compareParts = addCalendarDays(
    { year: lastMonthParts.year, month: lastMonthParts.month, day: 1 },
    compareDay - 1,
  );

  return {
    today: {
      key: 'today',
      label: 'Today',
      start: todayStart,
      end: now,
      compareStart: yesterdayStart,
      compareEnd: yesterdayEnd,
    },
    yesterday: {
      key: 'yesterday',
      label: 'Yesterday',
      start: yesterdayStart,
      end: yesterdayEnd,
      compareStart: dayBeforeYesterdayStart,
      compareEnd: dayBeforeYesterdayEnd,
    },
    monthToDate: {
      key: 'monthToDate',
      label: 'Month to date',
      start: monthStart,
      end: now,
      compareStart: lastMonthStart,
      compareEnd: endOfDayInTimeZone(
        zonedTimeToUtc(compareParts, timeZone),
        timeZone,
      ),
    },
    thisMonthForecast: {
      key: 'thisMonthForecast',
      label: 'This month (forecast)',
      start: monthStart,
      end: now,
      forecastDays: daysInMonth,
      elapsedDays: dayOfMonth,
    },
    lastMonth: {
      key: 'lastMonth',
      label: 'Last month',
      start: lastMonthStart,
      end: lastMonthEnd,
      compareStart: twoMonthsAgoStart,
      compareEnd: twoMonthsAgoEnd,
    },
  };
}

const ORDER_METRICS_FIELDS = {
  $addFields: {
    isCancelledOrder: {
      $in: ['$orderStatus', CANCELLED_ORDER_STATUSES],
    },
    isRefundLike: {
      $or: [
        { $in: ['$orderStatus', CANCELLED_ORDER_STATUSES] },
        { $eq: ['$hasCustomerReturn', true] },
      ],
    },
    resolvedUnits: {
      $cond: [
        { $in: ['$orderStatus', CANCELLED_ORDER_STATUSES] },
        0,
        {
          $reduce: {
            input: { $ifNull: ['$orderItems', []] },
            initialValue: 0,
            in: { $add: ['$$value', { $ifNull: ['$$this.quantityOrdered', 0] }] },
          },
        },
      ],
    },
    resolvedSales: {
      $cond: [
        { $in: ['$orderStatus', CANCELLED_ORDER_STATUSES] },
        0,
        {
          $let: {
            vars: {
              itemsTotal: {
                $reduce: {
                  input: { $ifNull: ['$orderItems', []] },
                  initialValue: 0,
                  in: {
                    $add: [
                      '$$value',
                      {
                        $max: [
                          0,
                          {
                            $subtract: [
                              { $ifNull: ['$$this.itemSubtotal.amount', 0] },
                              { $ifNull: ['$$this.promotionDiscount.amount', 0] },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                },
              },
              orderTotal: { $ifNull: ['$orderTotal.amount', 0] },
            },
            in: {
              $cond: [
                { $gt: ['$$orderTotal', 0] },
                '$$orderTotal',
                '$$itemsTotal',
              ],
            },
          },
        },
      ],
    },
    resolvedReferralFees: {
      $cond: [
        { $in: ['$orderStatus', CANCELLED_ORDER_STATUSES] },
        0,
        {
          $reduce: {
            input: { $ifNull: ['$orderItems', []] },
            initialValue: 0,
            in: { $add: ['$$value', { $ifNull: ['$$this.referralFee.amount', 0] }] },
          },
        },
      ],
    },
    resolvedFulfillmentFees: {
      $cond: [
        { $in: ['$orderStatus', CANCELLED_ORDER_STATUSES] },
        0,
        {
          $reduce: {
            input: { $ifNull: ['$orderItems', []] },
            initialValue: 0,
            in: { $add: ['$$value', { $ifNull: ['$$this.fulfillmentFee.amount', 0] }] },
          },
        },
      ],
    },
    resolvedCogs: {
      $cond: [
        { $in: ['$orderStatus', CANCELLED_ORDER_STATUSES] },
        0,
        {
          $reduce: {
            input: { $ifNull: ['$orderItems', []] },
            initialValue: 0,
            in: { $add: ['$$value', { $ifNull: ['$$this.costOfGoodsSold.amount', 0] }] },
          },
        },
      ],
    },
  },
};

function roundMoney(value) {
  return Math.round((value || 0) * 100) / 100;
}

module.exports = {
  CANCELLED_ORDER_STATUSES,
  MARKETPLACE_TIMEZONES,
  SALES_CHANNEL_TIMEZONES,
  resolveDashboardTimeZone,
  resolveOrderTimeZone,
  buildPresetPeriods,
  startOfDayInTimeZone,
  endOfDayInTimeZone,
  getDatePartsInTimeZone,
  zonedTimeToUtc,
  addCalendarDays,
  ORDER_METRICS_FIELDS,
  roundMoney,
};
