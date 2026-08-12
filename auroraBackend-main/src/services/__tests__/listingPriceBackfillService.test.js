const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeMoneyField,
  buildListingPriceUpdate,
  listingPriceFieldsDiffer,
} = require('../listingPriceBackfillService');

test('mergeMoneyField keeps existing value when parsed amount is zero', () => {
  const existing = { amount: 9.49, currency: 'USD' };
  const parsed = { amount: 0, currency: 'USD' };
  assert.deepEqual(mergeMoneyField(existing, parsed), existing);
});

test('buildListingPriceUpdate does not wipe existing bound prices', () => {
  const existing = {
    minimumPrice: { amount: 9.49, currency: 'USD' },
    maximumPrice: { amount: 14.98, currency: 'USD' },
    businessPrice: { amount: 9.9, currency: 'USD' },
  };
  const listing = {
    minimumPrice: { amount: 0, currency: 'USD' },
    maximumPrice: { amount: 0, currency: 'USD' },
    businessPrice: { amount: 0, currency: 'USD' },
  };

  assert.equal(buildListingPriceUpdate(existing, listing), null);
  assert.equal(listingPriceFieldsDiffer(existing, listing), false);
});

test('buildListingPriceUpdate fills missing bound prices from listing', () => {
  const existing = {
    minimumPrice: { amount: 0, currency: 'USD' },
    maximumPrice: { amount: 0, currency: 'USD' },
    businessPrice: { amount: 0, currency: 'USD' },
  };
  const listing = {
    minimumPrice: { amount: 9.49, currency: 'USD' },
    maximumPrice: { amount: 14.98, currency: 'USD' },
    businessPrice: { amount: 9.9, currency: 'USD' },
  };

  assert.deepEqual(buildListingPriceUpdate(existing, listing), listing);
});
