/**
 * One-shot: set latestReturnedActivityDate = max(latestCustomerReturnDate, latestRefundDate)
 * for every order that has either returns or refunds.
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Order = require('../src/models/Order');

  const cursor = Order.find({
    $or: [{ hasCustomerReturn: true }, { hasRefund: true }],
  })
    .select('_id latestCustomerReturnDate latestRefundDate latestReturnedActivityDate')
    .lean()
    .cursor();

  let scanned = 0;
  let updated = 0;
  const bulk = [];

  for await (const order of cursor) {
    scanned += 1;
    const dates = [order.latestCustomerReturnDate, order.latestRefundDate]
      .filter(Boolean)
      .map((d) => new Date(d).getTime())
      .filter((t) => Number.isFinite(t));
    if (dates.length === 0) continue;
    const activity = new Date(Math.max(...dates));
    const existing = order.latestReturnedActivityDate
      ? new Date(order.latestReturnedActivityDate).getTime()
      : null;
    if (existing === activity.getTime()) continue;

    bulk.push({
      updateOne: {
        filter: { _id: order._id },
        update: { $set: { latestReturnedActivityDate: activity } },
      },
    });

    if (bulk.length >= 500) {
      const result = await Order.bulkWrite(bulk, { ordered: false });
      updated += result.modifiedCount || 0;
      bulk.length = 0;
    }
  }

  if (bulk.length) {
    const result = await Order.bulkWrite(bulk, { ordered: false });
    updated += result.modifiedCount || 0;
  }

  console.log(`Scanned ${scanned} returned/refunded orders; updated ${updated}`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
