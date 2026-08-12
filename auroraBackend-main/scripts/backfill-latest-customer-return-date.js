/**
 * Backfill latestCustomerReturnDate for all sellers from customerReturns[].
 * Usage: node scripts/backfill-latest-customer-return-date.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { latestReturnDate } = require('../src/services/customerReturnsService');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Order = require('../src/models/Order');

  const cursor = Order.find({
    hasCustomerReturn: true,
    $or: [
      { latestCustomerReturnDate: { $exists: false } },
      { latestCustomerReturnDate: null },
    ],
  })
    .select('_id customerReturns')
    .lean()
    .cursor();

  let scanned = 0;
  let updated = 0;
  const bulk = [];

  for await (const order of cursor) {
    scanned += 1;
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
      updated += result.modifiedCount || 0;
      bulk.length = 0;
      console.log(`progress scanned=${scanned} updated=${updated}`);
    }
  }

  if (bulk.length) {
    const result = await Order.bulkWrite(bulk, { ordered: false });
    updated += result.modifiedCount || 0;
  }

  console.log(`done scanned=${scanned} updated=${updated}`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
