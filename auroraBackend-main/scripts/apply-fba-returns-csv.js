/**
 * One-shot: apply a local FBA customer returns CSV + backfill latestCustomerReturnDate.
 * Usage: node scripts/apply-fba-returns-csv.js <sellerEmailOrId> <csvPath>
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const {
  applyCustomerReturns,
  latestReturnDate,
} = require('../src/services/customerReturnsService');

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map((h) => h.replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = [];
    let cur = '';
    let inQ = false;
    for (const ch of lines[i]) {
      if (ch === '"') {
        inQ = !inQ;
        continue;
      }
      if (ch === ',' && !inQ) {
        cols.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    cols.push(cur);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx];
    });
    rows.push(row);
  }
  return rows;
}

(async () => {
  const sellerKey = process.argv[2];
  const csvPath = process.argv[3];
  if (!sellerKey || !csvPath) {
    console.error('Usage: node scripts/apply-fba-returns-csv.js <sellerEmailOrId> <csvPath>');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const User = require('../src/models/User');
  const Order = require('../src/models/Order');

  const user = mongoose.isValidObjectId(sellerKey)
    ? await User.findById(sellerKey)
    : await User.findOne({ email: new RegExp(sellerKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') });

  if (!user) {
    console.error('Seller not found');
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const applyStats = await applyCustomerReturns(user._id, rows);
  console.log('CSV apply', applyStats);

  const needingBackfill = await Order.find({
    sellerId: user._id,
    hasCustomerReturn: true,
    $or: [
      { latestCustomerReturnDate: { $exists: false } },
      { latestCustomerReturnDate: null },
    ],
  })
    .select('_id customerReturns')
    .lean();

  let backfilled = 0;
  const bulk = [];
  for (const order of needingBackfill) {
    const latest = latestReturnDate(order.customerReturns || []);
    if (!latest) continue;
    bulk.push({
      updateOne: {
        filter: { _id: order._id },
        update: { $set: { latestCustomerReturnDate: latest } },
      },
    });
    if (bulk.length >= 500) {
      const result = await Order.bulkWrite(bulk, { ordered: false });
      backfilled += result.modifiedCount || 0;
      bulk.length = 0;
    }
  }
  if (bulk.length) {
    const result = await Order.bulkWrite(bulk, { ordered: false });
    backfilled += result.modifiedCount || 0;
  }

  console.log('latestCustomerReturnDate backfilled', backfilled, 'of', needingBackfill.length);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
