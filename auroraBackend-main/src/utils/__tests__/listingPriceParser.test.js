const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractListingBoundPrices,
  extractOfferPrice,
} = require('../listingPriceParser');

const marketplaceId = 'ATVPDKIKX0DER';

test('extractListingBoundPrices reads B2B price from listings offers dataset', () => {
  const attributes = {
    purchasable_offer: [
      {
        marketplace_id: marketplaceId,
        currency: 'USD',
        audience: 'ALL',
        our_price: [{ schedule: [{ value_with_tax: 19.99 }] }],
        minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 14.5 }] }],
        maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: 29.99 }] }],
      },
    ],
  };
  const offers = [
    {
      marketplaceId,
      offerType: 'B2B',
      audience: { value: 'B2B' },
      price: { amount: '17.25', currencyCode: 'USD' },
    },
  ];

  const result = extractListingBoundPrices(attributes, marketplaceId, offers);
  assert.equal(result.minimumPrice, 14.5);
  assert.equal(result.maximumPrice, 29.99);
  assert.equal(result.businessPrice, 17.25);
});


test('extractOfferPrice reads our_price from purchasable_offer', () => {
  const attributes = {
    purchasable_offer: [
      {
        marketplace_id: marketplaceId,
        currency: 'USD',
        our_price: [{ schedule: [{ value_with_tax: 12.34 }] }],
      },
    ],
  };

  const result = extractOfferPrice(attributes, marketplaceId);
  assert.equal(result.amount, 12.34);
  assert.equal(result.currency, 'USD');
});

test('extractListingBoundPrices reads business price from B2B audience offer', () => {
  const attributes = {
    purchasable_offer: [
      {
        marketplace_id: marketplaceId,
        audience: 'ALL',
        currency: 'USD',
        our_price: [{ schedule: [{ value_with_tax: 9.99 }] }],
        minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 9.49 }] }],
        maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: 14.98 }] }],
      },
      {
        marketplace_id: marketplaceId,
        audience: 'B2B',
        currency: 'USD',
        our_price: [{ schedule: [{ value_with_tax: 9.9 }] }],
      },
    ],
  };

  const result = extractListingBoundPrices(attributes, marketplaceId);
  assert.equal(result.minimumPrice, 9.49);
  assert.equal(result.maximumPrice, 14.98);
  assert.equal(result.businessPrice, 9.9);
});

test('extractListingBoundPrices falls back to top-level attributes', () => {
  const attributes = {
    minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 8 }] }],
    maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: 20 }] }],
    business_price: [{ schedule: [{ value_with_tax: 9.5 }] }],
  };

  const result = extractListingBoundPrices(attributes, marketplaceId);
  assert.equal(result.minimumPrice, 8);
  assert.equal(result.maximumPrice, 20);
  assert.equal(result.businessPrice, 9.5);
});
