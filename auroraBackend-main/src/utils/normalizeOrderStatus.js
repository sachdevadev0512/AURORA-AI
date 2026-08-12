const CANONICAL_ORDER_STATUSES = [
  'Pending',
  'Unshipped',
  'PartiallyShipped',
  'Shipped',
  'InvoiceUnconfirmed',
  'Canceled',
  'Unfulfillable',
];

const CANCELLED_STATUS_VARIANTS = ['Canceled', 'Cancelled'];
const SHIPPED_STATUS_VARIANTS = ['Shipped', 'Shipping'];

function normalizeOrderStatus(status) {
  if (status == null || status === '') return null;

  const value = String(status).trim();
  const lower = value.toLowerCase();

  switch (lower) {
    case 'cancelled':
    case 'canceled':
      return 'Canceled';
    case 'shipping':
      return 'Shipped';
    case 'pending':
      return 'Pending';
    case 'unshipped':
      return 'Unshipped';
    case 'partiallyshipped':
      return 'PartiallyShipped';
    case 'shipped':
      return 'Shipped';
    case 'invoiceunconfirmed':
      return 'InvoiceUnconfirmed';
    case 'unfulfillable':
      return 'Unfulfillable';
    default:
      return value;
  }
}

function normalizeFulfillmentChannel(channel) {
  if (channel == null || channel === '') return null;

  const value = String(channel).trim();
  const upper = value.toUpperCase();

  if (upper === 'AFN' || upper === 'AMAZON' || upper === 'FBA') {
    return 'AFN';
  }

  if (upper === 'MFN' || upper === 'MERCHANT' || upper === 'FBM' || upper === 'DEFAULT') {
    return 'MFN';
  }

  return value;
}

function buildFulfillmentChannelQuery(channelParam) {
  if (!channelParam) return null;

  const normalized = normalizeFulfillmentChannel(channelParam) || String(channelParam).trim();

  if (normalized === 'AFN') {
    return { $in: ['AFN', 'Amazon', 'amazon', 'FBA', 'fba'] };
  }

  if (normalized === 'MFN') {
    return { $in: ['MFN', 'Merchant', 'merchant', 'FBM', 'fbm', 'DEFAULT', 'Default'] };
  }

  return normalized;
}

module.exports = {
  CANONICAL_ORDER_STATUSES,
  CANCELLED_STATUS_VARIANTS,
  SHIPPED_STATUS_VARIANTS,
  normalizeOrderStatus,
  normalizeFulfillmentChannel,
  buildFulfillmentChannelQuery,
};
