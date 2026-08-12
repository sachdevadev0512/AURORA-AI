/**
 * Overwrite listingCreatedDate / lastUpdatedTime for every Amazon-linked seller.
 * Uses Listings Items API + FBA ledger for Seller Central–aligned last-updated dates.
 *
 * Usage: node scripts/backfill-product-listing-dates-listings-api.js [email]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
if (process.env.LISTING_DATES_USE_LEDGER == null) {
  process.env.LISTING_DATES_USE_LEDGER = 'true';
}
const mongoose = require('mongoose');
const { syncListingDatesFromListingsApi } = require('../src/services/listingDatesSyncService');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const User = require('../src/models/User');
  const Product = require('../src/models/Product');
  const AmazonAPI = require('../src/utils/amazonAPI');
  const { getSellerAppCredentials } = require('../src/utils/sellerAppHelper');

  const emailFilter = process.argv[2] || null;
  const userQuery = {
    amazonRefreshToken: { $exists: true, $nin: [null, ''] },
    amazonSellerId: { $exists: true, $nin: [null, ''] },
  };
  if (emailFilter) userQuery.email = emailFilter;

  const users = await User.find(userQuery);

  for (const user of users) {
    console.log(`\n=== ${user.email} ===`);
    try {
      const creds = await getSellerAppCredentials(user._id);
      const api = new AmazonAPI(user, creds);
      const result = await syncListingDatesFromListingsApi({
        user,
        amazonAPI: api,
        mode: 'search_and_get_missing',
        useLedger: true,
      });

      const total = await Product.countDocuments({ sellerId: user._id });
      const withCreated = await Product.countDocuments({
        sellerId: user._id,
        listingCreatedDate: { $ne: null },
      });
      const withUpdated = await Product.countDocuments({
        sellerId: user._id,
        lastUpdatedTime: { $ne: null },
      });
      console.log({ ...result, total, withCreated, withUpdated });
    } catch (err) {
      console.error(`failed for ${user.email}:`, err.message);
    }
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
