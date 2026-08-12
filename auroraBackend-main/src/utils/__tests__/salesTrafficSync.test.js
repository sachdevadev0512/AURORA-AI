const { buildSalesTrafficReportRange, aggregateSalesAndTrafficByAsin } = require('../salesTrafficWindow');

describe('buildSalesTrafficReportRange', () => {
  test('uses marketplace-local calendar dates for last 30 days ending yesterday', () => {
    const user = { marketplace: 'NA', amazonMarketplaceIds: ['ATVPDKIKX0DER'] };
    const now = new Date('2026-07-16T18:00:00.000Z'); // Jul 16 morning in LA
    const range = buildSalesTrafficReportRange(user, 30, 1, now);
    expect(range.timeZone).toBe('America/Los_Angeles');
    expect(range.startDate).toBe('2026-06-16');
    expect(range.endDate).toBe('2026-07-15');
  });
});

describe('aggregateSalesAndTrafficByAsin', () => {
  test('aggregates unitsOrdered per child ASIN (B2B is a subset, not additive)', () => {
    const byAsin = aggregateSalesAndTrafficByAsin({
      salesAndTrafficByAsin: [
        {
          childAsin: 'B000L9TJXO',
          salesByAsin: { unitsOrdered: 142, unitsOrderedB2B: 1 },
          trafficByAsin: { pageViews: 100 },
        },
        {
          childAsin: 'B000L9TJXO',
          salesByAsin: { unitsOrdered: 5, unitsOrderedB2B: 0 },
          trafficByAsin: { pageViews: 20 },
        },
      ],
    });
    expect(byAsin.get('B000L9TJXO')).toEqual({ unitsSold: 147, pageViews: 120 });
  });

  test('falls back to browser+mobile page views when pageViews missing', () => {
    const byAsin = aggregateSalesAndTrafficByAsin({
      salesAndTrafficByAsin: [
        {
          childAsin: 'B001',
          salesByAsin: { unitsOrdered: 3 },
          trafficByAsin: { browserPageViews: 10, mobileAppPageViews: 5 },
        },
      ],
    });
    expect(byAsin.get('B001')).toEqual({ unitsSold: 3, pageViews: 15 });
  });
});
