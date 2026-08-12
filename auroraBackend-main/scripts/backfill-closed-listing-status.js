/**
 * Backfill Closed vs Inactive using purchasable_offer.end_at from Listings Items.
 * Usage: node scripts/backfill-closed-listing-status.js [email]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const AmazonAPI = require('../src/utils/amazonAPI');
const { backfillClosedListingStatuses } = require('../src/services/closedListingStatusService');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const emailFilter = process.argv[2];
  const users = emailFilter
    ? await User.find({ email: emailFilter })
    : await User.find({
        amazonRefreshToken: { $exists: true, $ne: null },
        amazonSellerId: { $exists: true, $ne: null },
      });

  let totalUpdated = 0;
  for (const user of users) {
    try {
      const api = new AmazonAPI(user);
      const result = await backfillClosedListingStatuses({
        sellerId: user._id,
        amazonAPI: api,
        marketplaceId: api.getMarketplaceId(),
        onProgress: ({ idx, total, sku, status }) => {
          if (status && idx % 25 === 0) {
            console.log(`[${user.email}] ${idx}/${total} ${sku} → ${status}`);
          }
        },
      });
      totalUpdated += result.updated;
      console.log(`[${user.email}]`, result);
    } catch (e) {
      console.error(`[${user.email}] failed:`, e.message);
    }
  }
  console.log('done, totalUpdated', totalUpdated);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
