// Standalone local test for the FBA inbound placement fee sync service.
// Run: node scripts/test-fba-placement-sync.js <user_id>
//
// Bypasses the HTTP layer and the wrapping inventorySyncService — instantiates
// AmazonAPI against the shared Mongo, calls the sync function with force=true,
// and prints the result + a sample of the persisted doc.

require('dotenv').config();
const mongoose = require('mongoose');

const targetUserId = process.argv[2] || '6a3fa17bbfbe2c60e4207a68';

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI / MONGO_URI missing');
  const dbName = process.env.MONGO_DB_NAME || undefined;
  await mongoose.connect(uri, { dbName });
  console.log(`[test] connected to Mongo db=${mongoose.connection.name}`);

  const User = require('../src/models/User');
  const FbaInboundPlacementFee = require('../src/models/FbaInboundPlacementFee');
  const {
    syncFbaInboundPlacementFees,
  } = require('../src/services/fbaInboundPlacementSyncService');

  const user = await User.findById(targetUserId).lean();
  if (!user) {
    console.error(`[test] user ${targetUserId} not found`);
    process.exit(1);
  }
  console.log(
    `[test] user=${user.email || user._id}  connected=${!!user.amazonRefreshToken}  marketplace=${user.marketplace}`,
  );

  const t0 = Date.now();
  let result;
  try {
    result = await syncFbaInboundPlacementFees(user, { force: true });
  } catch (err) {
    console.error(`[test] sync threw after ${Date.now() - t0}ms:`, err.message);
    console.error(err.stack);
    await mongoose.disconnect();
    process.exit(2);
  }
  console.log(`[test] sync returned after ${Date.now() - t0}ms:`, result);

  const doc = await FbaInboundPlacementFee.findOne({ sellerId: user._id }).lean();
  if (!doc) {
    console.log('[test] no doc persisted');
  } else {
    const perSku = doc.perSku || {};
    const entries = Object.entries(perSku);
    const events = doc.events || [];
    console.log(
      `[test] persisted doc: source=${doc.source} updatedAt=${doc.updatedAt}  windowStart=${doc.windowStart}  windowEnd=${doc.windowEnd}  skus=${entries.length} events=${events.length}`,
    );
    for (const [sku, v] of entries.slice(0, 5)) {
      console.log(`  ${sku}: ${JSON.stringify(v)}`);
    }
    const byMonth = {};
    for (const ev of events) {
      const day = String(ev.transaction_date || '').slice(0, 7);
      if (!day) continue;
      byMonth[day] = (byMonth[day] || 0) + Number(ev.fee_total || 0);
    }
    console.log('[test] fee totals by month (YYYY-MM):', byMonth);
    console.log('[test] sample events:', events.slice(0, 3));
  }

  await mongoose.disconnect();
  console.log('[test] done');
})();
