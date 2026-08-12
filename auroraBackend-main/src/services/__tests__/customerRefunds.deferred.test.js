/**
 * Unit tests for refund parsers — especially DEFERRED listTransactions rows
 * that Finances v0 RefundEventList omits (Seller Central "Refund applied").
 */
const {
  parseRefundTransaction,
  parseRefundEvent,
  mergeRefundRows,
} = require('../customerRefundsService');

describe('parseRefundTransaction (listTransactions / DEFERRED)', () => {
  const deferredRefundTx = {
    transactionType: 'Refund',
    transactionStatus: 'DEFERRED',
    description: 'Refund',
    postedDate: '2026-07-30T18:24:32Z',
    totalAmount: { currencyAmount: -10, currencyCode: 'USD' },
    relatedIdentifiers: [
      { relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: '111-5230199-4965029' },
      { relatedIdentifierName: 'REFUND_ID', relatedIdentifierValue: 'amzn1:crow:test' },
    ],
    marketplaceDetails: { marketplaceName: 'Amazon.com' },
    items: [
      {
        description: 'KIWI Polish',
        totalAmount: { currencyAmount: -3.82, currencyCode: 'USD' },
        contexts: [{
          contextType: 'ProductContext',
          sku: 'ASG-KIWI Liquid Polish Brown',
          asin: 'B000L9TJXO',
          quantityShipped: 1,
        }],
        breakdowns: [{
          breakdownType: 'ProductCharges',
          breakdownAmount: { currencyAmount: -5.68, currencyCode: 'USD' },
          breakdowns: [{
            breakdownType: 'OurPricePrincipal',
            breakdownAmount: { currencyAmount: -5.68, currencyCode: 'USD' },
          }],
        }],
      },
      {
        description: 'KIWI Polish',
        totalAmount: { currencyAmount: -6.18, currencyCode: 'USD' },
        contexts: [{
          contextType: 'ProductContext',
          sku: 'ASG-KIWI Liquid Polish Brown',
          asin: 'B000L9TJXO',
          quantityShipped: 1,
        }],
        breakdowns: [{
          breakdownType: 'ProductCharges',
          breakdownAmount: { currencyAmount: -5.68, currencyCode: 'USD' },
          breakdowns: [{
            breakdownType: 'OurPricePrincipal',
            breakdownAmount: { currencyAmount: -5.68, currencyCode: 'USD' },
          }],
        }],
      },
    ],
  };

  test('sums multi-item same-SKU deferred refund to match Refund applied (N)', () => {
    const parsed = parseRefundTransaction(deferredRefundTx);
    expect(parsed).not.toBeNull();
    expect(parsed.amazonOrderId).toBe('111-5230199-4965029');
    expect(parsed.refunds).toHaveLength(1);
    expect(parsed.refunds[0]).toMatchObject({
      sku: 'ASG-KIWI Liquid Polish Brown',
      asin: 'B000L9TJXO',
      quantity: 2,
      amount: 11.36,
      source: 'list_transactions',
      transactionStatus: 'DEFERRED',
    });
  });

  test('ignores non-refund transactions', () => {
    expect(parseRefundTransaction({
      ...deferredRefundTx,
      transactionType: 'Shipment',
    })).toBeNull();
  });

  test('skips $0 fee-adjustment items that still carry ProductContext qty', () => {
    const parsed = parseRefundTransaction({
      transactionType: 'Refund',
      transactionStatus: 'RELEASED',
      postedDate: '2026-06-06T00:17:33Z',
      totalAmount: { currencyAmount: 0, currencyCode: 'USD' },
      relatedIdentifiers: [
        { relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: '111-3339958-8334639' },
        { relatedIdentifierName: 'REFUND_ID', relatedIdentifierValue: 'amzn1:crow:zero' },
      ],
      items: [{
        description: 'UNO',
        totalAmount: { currencyAmount: 0, currencyCode: 'USD' },
        contexts: [{
          contextType: 'ProductContext',
          sku: 'ASG-UNO PO2 -193',
          asin: 'B07DCXC193',
          quantityShipped: 6,
        }],
        breakdowns: [],
      }],
    });
    expect(parsed).toBeNull();
  });

  test('returns null without ORDER_ID', () => {
    expect(parseRefundTransaction({
      ...deferredRefundTx,
      relatedIdentifiers: [],
    })).toBeNull();
  });
});

describe('parseRefundEvent (Finances v0)', () => {
  test('parses principal + quantity from ShipmentItemAdjustmentList', () => {
    const parsed = parseRefundEvent({
      AmazonOrderId: '111-5230199-4965029',
      PostedDate: '2026-08-01T12:00:00Z',
      MarketplaceName: 'Amazon.com',
      ShipmentItemAdjustmentList: [{
        SellerSKU: 'ASG-KIWI Liquid Polish Brown',
        QuantityShipped: -2,
        ItemChargeAdjustmentList: [{
          ChargeType: 'Principal',
          ChargeAmount: { CurrencyAmount: -11.36, CurrencyCode: 'USD' },
        }],
      }],
    });
    expect(parsed.refunds[0]).toMatchObject({
      sku: 'ASG-KIWI Liquid Polish Brown',
      quantity: 2,
      amount: 11.36,
      source: 'finances_v0',
    });
  });
});

describe('mergeRefundRows', () => {
  test('dedupes identical rows', () => {
    const row = {
      refundDate: new Date('2026-07-30T18:24:32Z'),
      sku: 'X',
      quantity: 2,
      amount: 11.36,
      currency: 'USD',
      source: 'list_transactions',
      refundId: 'r1',
    };
    expect(mergeRefundRows([row], [row])).toHaveLength(1);
  });

  test('collapses DEFERRED + RELEASED for same refundId to one row', () => {
    const deferred = {
      refundDate: new Date('2026-06-05T00:58:03Z'),
      sku: 'ASG - Kiwi Shoe Shine Sponge Black 7ml',
      quantity: 6,
      amount: 30.18,
      currency: 'USD',
      source: 'list_transactions',
      transactionStatus: 'DEFERRED_RELEASED',
      refundId: 'amzn1:crow:9Ss874fARQqSJrYUP2fhTQ',
    };
    const released = {
      refundDate: new Date('2026-06-11T17:38:17Z'),
      sku: 'ASG - Kiwi Shoe Shine Sponge Black 7ml',
      quantity: 6,
      amount: 30.18,
      currency: 'USD',
      source: 'list_transactions',
      transactionStatus: 'RELEASED',
      refundId: 'amzn1:crow:9Ss874fARQqSJrYUP2fhTQ',
    };
    const merged = mergeRefundRows([deferred], [released]);
    expect(merged).toHaveLength(1);
    expect(merged[0].transactionStatus).toBe('RELEASED');
    expect(merged[0].quantity).toBe(6);
  });
});
