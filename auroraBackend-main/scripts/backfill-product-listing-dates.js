/**
 * Backfill listingCreatedDate (All Listings open-date) and lastUpdatedTime
 * (FBA inventory summaries) for every Amazon-linked seller.
 *
 * Usage: node scripts/backfill-product-listing-dates.js
 * Optional: node scripts/backfill-product-listing-dates.js rawyalusa@gmail.com
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const {
  parseAmazonOpenDate,
  coerceValidDate,
} = require('../src/utils/productListingUtils');

function reportCell(row, key) {
  if (!row || typeof row !== 'object') return '';
  if (row[key] != null && row[key] !== '') return row[key];
  const found = Object.keys(row).find((k) => k.toLowerCase() === String(key).toLowerCase());
  return found != null ? row[found] : '';
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const User = require('../src/models/User');
  const Product = require('../src/models/Product');
  const AmazonAPI = require('../src/utils/amazonAPI');
  const { getSellerAppCredentials } = require('../src/utils/sellerAppHelper');

  const emailFilter = process.argv[2] || null;
  const userQuery = {
    amazonRefreshToken: { $exists: true, $nin: [null, ''] },
  };
  if (emailFilter) userQuery.email = emailFilter;

  const users = await User.find(userQuery);

  for (const user of users) {
    console.log(`\n=== ${user.email} ===`);
    try {
      const creds = await getSellerAppCredentials(user._id);
      const api = new AmazonAPI(user, creds);

      // Clear corrupt lastUpdatedTime values (e.g. {})
      const cleared = await Product.updateMany(
        {
          sellerId: user._id,
          lastUpdatedTime: { $type: 'object' },
        },
        { $set: { lastUpdatedTime: null } },
      );
      if (cleared.modifiedCount) {
        console.log(`cleared corrupt lastUpdatedTime: ${cleared.modifiedCount}`);
      }

      console.log('Fetching All Listings report…');
      const listingRows = await api.fetchAllListingsReport();
      let createdUpdated = 0;
      for (const row of listingRows) {
        const sku = String(reportCell(row, 'seller-sku') || '').trim();
        if (!sku) continue;
        const openDate = parseAmazonOpenDate(reportCell(row, 'open-date'));
        if (!openDate) continue;
        const result = await Product.updateOne(
          { sellerId: user._id, sku },
          { $set: { listingCreatedDate: openDate } },
        );
        if (result.modifiedCount) createdUpdated += 1;
      }
      console.log(`listingCreatedDate updated: ${createdUpdated}`);

      console.log('Fetching FBA inventory lastUpdatedTime…');
      let nextToken = null;
      let lastUpdatedCount = 0;
      do {
        const page = await api.getInventorySummariesPage(nextToken);
        for (const item of page.items || []) {
          const sku = item.sellerSku;
          const lastUpdated = coerceValidDate(item.lastUpdatedTime);
          if (!sku || !lastUpdated) continue;
          const result = await Product.updateOne(
            { sellerId: user._id, sku },
            { $set: { lastUpdatedTime: lastUpdated } },
          );
          if (result.modifiedCount) lastUpdatedCount += 1;
        }
        nextToken = page.nextToken;
      } while (nextToken);
      console.log(`lastUpdatedTime updated: ${lastUpdatedCount}`);

      const total = await Product.countDocuments({ sellerId: user._id });
      const withCreated = await Product.countDocuments({
        sellerId: user._id,
        listingCreatedDate: { $ne: null },
      });
      const withUpdated = await Product.countDocuments({
        sellerId: user._id,
        lastUpdatedTime: { $ne: null },
      });
      console.log({ total, withCreated, withUpdated });
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
