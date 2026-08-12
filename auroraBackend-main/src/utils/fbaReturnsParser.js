const customerReturnSchema = {
  returnDate: Date,
  sku: String,
  asin: String,
  fnsku: String,
  productName: String,
  quantity: Number,
  fulfillmentCenterId: String,
  disposition: String,
  reason: String,
  status: String,
};

function readField(row, ...keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value != null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return null;
}

function parseReturnRow(row) {
  const orderId = readField(row, 'order-id', 'order_id', 'amazon-order-id', 'amazon_order_id');
  if (!orderId) return null;

  const returnDateRaw = readField(row, 'return-date', 'return_date');
  const quantityRaw = readField(row, 'quantity');

  return {
    amazonOrderId: orderId,
    return: {
      returnDate: returnDateRaw ? new Date(returnDateRaw) : null,
      sku: readField(row, 'sku', 'seller-sku', 'seller_sku'),
      asin: readField(row, 'asin'),
      fnsku: readField(row, 'fnsku', 'fnsku'),
      productName: readField(row, 'product-name', 'product_name'),
      quantity: Number.parseInt(quantityRaw || '1', 10) || 1,
      fulfillmentCenterId: readField(row, 'fulfillment-center-id', 'fulfillment_center_id'),
      disposition: readField(row, 'detailed-disposition', 'detailed_disposition', 'disposition'),
      reason: readField(row, 'reason'),
      status: readField(row, 'status'),
    },
  };
}

function groupReturnsByOrderId(rows) {
  const grouped = new Map();

  for (const row of rows || []) {
    const parsed = parseReturnRow(row);
    if (!parsed) continue;

    if (!grouped.has(parsed.amazonOrderId)) {
      grouped.set(parsed.amazonOrderId, []);
    }
    grouped.get(parsed.amazonOrderId).push(parsed.return);
  }

  return grouped;
}

module.exports = {
  customerReturnSchema,
  parseReturnRow,
  groupReturnsByOrderId,
};
