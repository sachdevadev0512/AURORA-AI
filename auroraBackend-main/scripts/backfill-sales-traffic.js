/**
 * Re-sync Units Sold / Page Views from Amazon Sales & Traffic for all sellers.
 * Usage: node scripts/backfill-sales-traffic.js [email]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const { enrichSalesAndTraffic } = require('../src/services/salesTrafficSyncService');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const emailFilter = process.argv[2];
  const users = emailFilter
    ? await User.find({ email: emailFilter })
    : await User.find({
        amazonRefreshToken: { $exists: true, $ne: null },
        amazonSellerId: { $exists: true, $ne: null },
      });

  for (const user of users) {
    try {
      const result = await enrichSalesAndTraffic(user);
      console.log(`[${user.email}]`, result);
    } catch (e) {
      console.error(`[${user.email}]`, e.message);
    }
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
