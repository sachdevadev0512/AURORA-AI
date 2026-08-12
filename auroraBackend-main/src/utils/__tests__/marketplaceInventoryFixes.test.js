const {
  preferMarketplaceId,
  sortMarketplaceIds,
} = require('../marketplacePriority');
const { mapConditionType, reportItemChanged, isUnchangedProduct } = require('../listingItemParse');
const { mapAmazonListingStatus } = require('../productListingUtils');
const { extractPrimaryImage } = require('../productDocumentBuilder');

describe('marketplacePriority', () => {
  test('prefers US over MX for NA sellers', () => {
    const ids = ['A1AM78C64UM0Y8', 'A2EUQ1WTGCTBG2', 'ATVPDKIKX0DER'];
    expect(preferMarketplaceId(ids, 'NA')).toBe('ATVPDKIKX0DER');
    expect(sortMarketplaceIds(ids, 'NA')[0]).toBe('ATVPDKIKX0DER');
  });
});

describe('listing status mapping', () => {
  test('maps report Active/Inactive/Incomplete/Closed', () => {
    expect(mapAmazonListingStatus('Active')).toBe('Active');
    expect(mapAmazonListingStatus('inactive')).toBe('Inactive');
    expect(mapAmazonListingStatus('Incomplete')).toBe('Incomplete');
    expect(mapAmazonListingStatus('Closed')).toBe('Closed');
  });

  test('maps BUYABLE listingStatus to Active', () => {
    expect(mapAmazonListingStatus(null, 'BUYABLE, DISCOVERABLE')).toBe('Active');
    expect(mapAmazonListingStatus(null, 'DISCOVERABLE')).toBe('Inactive');
  });

  test('detects Closed from past purchasable_offer end_at', () => {
    const { deriveProductStatus, isPurchasableOfferClosed } = require('../productListingUtils');
    const closedAttrs = {
      purchasable_offer: [
        {
          marketplace_id: 'ATVPDKIKX0DER',
          end_at: { value: '2026-06-27T11:13:07.682Z' },
        },
      ],
    };
    const openAttrs = {
      purchasable_offer: [
        {
          marketplace_id: 'ATVPDKIKX0DER',
          end_at: { value: null },
        },
      ],
    };
    expect(isPurchasableOfferClosed(closedAttrs, 'ATVPDKIKX0DER')).toBe(true);
    expect(isPurchasableOfferClosed(openAttrs, 'ATVPDKIKX0DER')).toBe(false);
    expect(
      deriveProductStatus({
        listingStatus: 'DISCOVERABLE',
        attributes: closedAttrs,
        marketplaceId: 'ATVPDKIKX0DER',
      })
    ).toBe('Closed');
    expect(
      deriveProductStatus({
        listingStatus: 'DISCOVERABLE',
        attributes: openAttrs,
        marketplaceId: 'ATVPDKIKX0DER',
      })
    ).toBe('Inactive');
  });
});

describe('extractPrimaryImage', () => {
  test('prefers MAIN catalog variant', () => {
    const catalog = {
      images: [
        {
          images: [
            { variant: 'PT01', link: 'https://example.com/pt.jpg', height: 100, width: 100 },
            { variant: 'MAIN', link: 'https://example.com/main.jpg', height: 500, width: 500 },
          ],
        },
      ],
    };
    expect(extractPrimaryImage(catalog)[0].url).toBe('https://example.com/main.jpg');
  });

  test('falls back to listing mainImage then existing', () => {
    expect(
      extractPrimaryImage(null, { mainImage: { link: 'https://example.com/listing.jpg' } })[0].url
    ).toBe('https://example.com/listing.jpg');
    expect(
      extractPrimaryImage(null, {
        existingImages: [{ url: 'https://example.com/old.jpg', height: 1, width: 1 }],
      })[0].url
    ).toBe('https://example.com/old.jpg');
  });
});

describe('listingItemParse inventory + condition', () => {
  test('maps new_new to New not new new', () => {
    expect(mapConditionType('new_new')).toBe('New');
    expect(mapConditionType('NewItem')).toBe('New');
    expect(mapConditionType('11')).toBe('New');
  });

  test('reportItemChanged detects inbound/unfulfillable drift', () => {
    const existing = {
      asin: 'B005GYKTCY',
      status: 'Active',
      images: [{ url: 'https://example.com/x.jpg' }],
      price: { amount: 4.9 },
      inventory: {
        fulfillableQuantity: 89,
        reservedQuantity: 18,
        inboundQuantity: 430,
        unfulfillableQuantity: 3,
        totalQuantity: 541,
      },
    };
    const fbaItem = {
      asin: 'B005GYKTCY',
      totalQuantity: 589,
      inventoryDetails: {
        fulfillableQuantity: 89,
        reservedQuantity: {
          totalReservedQuantity: 19,
          pendingCustomerOrderQuantity: 0,
          pendingTransshipmentQuantity: 1,
          fcProcessingQuantity: 18,
        },
        inboundWorkingQuantity: 0,
        inboundShippedQuantity: 480,
        inboundReceivingQuantity: 0,
        unfulfillableQuantity: { totalUnfulfillableQuantity: 1 },
      },
    };
    expect(reportItemChanged(existing, { status: 'Active', price: { amount: 4.9 } }, fbaItem, null, null)).toBe(
      true,
    );
    expect(isUnchangedProduct(fbaItem, null, existing, null)).toBe(false);

    const matched = {
      ...existing,
      inventory: {
        fulfillableQuantity: 89,
        reservedQuantity: 18,
        inboundQuantity: 480,
        unfulfillableQuantity: 1,
        totalQuantity: 589,
      },
    };
    expect(isUnchangedProduct(fbaItem, null, matched, null)).toBe(true);
  });

  test('reportItemChanged forces rewrite when images missing', () => {
    const existing = {
      asin: 'B01N3489RH',
      status: 'Inactive',
      images: [],
      price: { amount: 7.99 },
      inventory: { fulfillableQuantity: 10 },
    };
    expect(
      reportItemChanged(
        existing,
        { status: 'Inactive', price: { amount: 7.99 } },
        { inventoryDetails: { fulfillableQuantity: 10 } },
        null,
        null
      )
    ).toBe(true);
  });
});
