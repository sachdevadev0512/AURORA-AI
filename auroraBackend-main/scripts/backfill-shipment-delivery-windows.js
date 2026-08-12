/**
 * Backfill FBA Delivery Window (selectedDeliveryWindow) for every Amazon-linked seller.
 * Usage: node scripts/backfill-shipment-delivery-windows.js
 * Optional: node scripts/backfill-shipment-delivery-windows.js asglobal@gmail.com
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
  const { isPlausibleDeliveryWindow } = require('../src/utils/shipmentParser');

  const emailFilter = process.argv[2] || null;
  const userQuery = {
    amazonRefreshToken: { $exists: true, $nin: [null, ''] },
  };
  if (emailFilter) userQuery.email = emailFilter;

  const users = await User.find(userQuery).select(
    'email amazonRefreshToken amazonSellerId marketplace amazonMarketplaceIds',
  );

  for (const user of users) {
    const rows = await Shipment.find({ sellerId: user._id, shipmentType: 'fba_fc' })
      .select('shipDate estimatedDeliveryDate inboundPlanId')
      .lean();
    const beforeMissing = rows.filter(
      (r) => !isPlausibleDeliveryWindow(r.shipDate, r.estimatedDeliveryDate, null),
    ).length;
    const withPlan = rows.filter((r) => r.inboundPlanId).length;
    console.log(
      `\n=== ${user.email} === fba=${rows.length} missingWindow=${beforeMissing} withPlan=${withPlan}`,
    );
    if (!beforeMissing) continue;

    try {
      const creds = await getSellerAppCredentials(user._id);
      const api = new AmazonAPI(user, creds);
      const updated = await shipmentSyncManager.backfillFbaDeliveryWindows(user, api);
      console.log(`updated=${updated}`);
    } catch (err) {
      console.error(`failed for ${user.email}:`, err.message);
    }

    const after = await Shipment.find({ sellerId: user._id, shipmentType: 'fba_fc' })
      .select('shipDate estimatedDeliveryDate')
      .lean();
    const afterMissing = after.filter(
      (r) => !isPlausibleDeliveryWindow(r.shipDate, r.estimatedDeliveryDate, null),
    ).length;
    console.log(`after missingWindow=${afterMissing} withWindow=${after.length - afterMissing}`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
