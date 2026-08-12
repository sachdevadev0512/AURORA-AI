require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../src/models/Product');
const User = require('../src/models/User');
const AmazonAPI = require('../src/utils/amazonAPI');
const { getSellerAppCredentials } = require('../src/utils/sellerAppHelper');
const { backfillListingBoundPrices } = require('../src/services/listingPriceBackfillService');

const asin = process.argv.find((arg) => /^B0/i.test(arg)) || null;

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const filter = asin
    ? { asin }
    : {
        $or: [
          { 'minimumPrice.amount': { $lte: 0 } },
          { 'maximumPrice.amount': { $lte: 0 } },
          { 'businessPrice.amount': { $lte: 0 } },
        ],
      };

  const sellerIds = await Product.distinct('sellerId', filter);
  let total = { scanned: 0, updated: 0, noData: 0, failed: 0 };

  for (const sellerId of sellerIds) {
    const user = await User.findById(sellerId).lean();
    if (!user) continue;
    const creds = await getSellerAppCredentials(user);
    const api = new AmazonAPI({ ...user, ...creds });
    const result = await backfillListingBoundPrices({
      sellerId,
      amazonAPI: api,
      marketplaceId: api.getMarketplaceId(),
      asin,
      onProgress: ({ asin: progressAsin, update }) => {
        if (update) {
          console.log(
            progressAsin,
            `min=${update.minimumPrice?.amount ?? 0}`,
            `max=${update.maximumPrice?.amount ?? 0}`,
            `b2b=${update.businessPrice?.amount ?? 0}`,
          );
        }
      },
    });
    total.scanned += result.scanned;
    total.updated += result.updated;
    total.noData += result.noData;
    total.failed += result.failed;
  }

  console.log('Done.', total);
  await mongoose.disconnect();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
