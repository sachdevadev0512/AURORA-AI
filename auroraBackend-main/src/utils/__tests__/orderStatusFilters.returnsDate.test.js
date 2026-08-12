const {
  applyOrderListDateRange,
  isReturnedStatusFilter,
  buildOrderStatusQuery,
} = require('../orderStatusFilters');

describe('returned orders date filter', () => {
  test('isReturnedStatusFilter recognizes returned', () => {
    expect(isReturnedStatusFilter('returned')).toBe(true);
    expect(isReturnedStatusFilter('Returned')).toBe(true);
    expect(isReturnedStatusFilter('shipped')).toBe(false);
  });

  test('returned status includes FBA returns AND Finances refunds', () => {
    const statusQuery = buildOrderStatusQuery('returned');
    const serialized = JSON.stringify(statusQuery);
    expect(serialized).toContain('hasCustomerReturn');
    expect(serialized).toContain('hasRefund');
  });

  test('returned status filters by purchaseDate (same as other tabs)', () => {
    const range = {
      $gte: new Date('2026-06-27T00:00:00.000Z'),
      $lte: new Date('2026-07-27T00:00:00.000Z'),
    };
    const base = { sellerId: 'abc' };
    const withStatus = { ...base, ...buildOrderStatusQuery('returned') };
    const query = applyOrderListDateRange(withStatus, range, 'returned');

    expect(query.purchaseDate).toEqual(range);
    const serialized = JSON.stringify(query);
    expect(serialized).not.toContain('customerReturns.returnDate');
  });

  test('non-returned status keeps purchaseDate filter', () => {
    const range = {
      $gte: new Date('2026-06-27T00:00:00.000Z'),
      $lte: new Date('2026-07-27T00:00:00.000Z'),
    };
    const query = applyOrderListDateRange({ sellerId: 'abc' }, range, 'shipped');
    expect(query.purchaseDate).toEqual(range);
  });
});
