/**
 * Backfill AWD Amazon Reference IDs (warehouseReferenceId) for all sellers.
 * Usage: node scripts/backfill-awd-reference-ids.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const User = require('../src/models/User');
  const Shipment = require('../src/models/Shipment');
  const AmazonAPI = require('../src/utils/amazonAPI');
  const { getSellerAppCredentials } = require('../src/utils/sellerAppHelper');
  const { shipmentSyncManager } = require('../src/services/shipmentSyncService');
  const { looksLikeAmazonReferenceId } = require('../src/utils/shipmentParser');

  const users = await User.find({
    amazonRefreshToken: { $exists: true, $nin: [null, ''] },
  }).select('email amazonRefreshToken amazonSellerId marketplace amazonMarketplaceIds');

  for (const user of users) {
    const rows = await Shipment.find({ sellerId: user._id, shipmentType: 'awd_dc' })
      .select('shipmentId referenceId metadata')
      .lean();
    const bad = rows.filter((r) => !looksLikeAmazonReferenceId(r.referenceId));
    console.log(`\n=== ${user.email} === awd=${rows.length} badRef=${bad.length}`);
    if (!rows.length) continue;

    try {
      const creds = await getSellerAppCredentials(user._id);
      const api = new AmazonAPI(user, creds);
      const updated = await shipmentSyncManager.backfillAwdReferenceIds(user, api);
      console.log(`updated=${updated}`);
    } catch (err) {
      console.error(`failed for ${user.email}:`, err.message);
    }

    const after = await Shipment.find({ sellerId: user._id, shipmentType: 'awd_dc' })
      .select('shipmentId referenceId')
      .lean();
    const stillBad = after.filter((r) => !looksLikeAmazonReferenceId(r.referenceId));
    console.log(
      'sample:',
      after.slice(0, 5).map((r) => `${r.shipmentId}=${r.referenceId}`).join(' | '),
    );
    console.log(`after badRef=${stillBad.length}`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
