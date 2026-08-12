/**
 * Backfill inbound placement fees from Amazon Finances (listTransactions)
 * for every connected seller — no CSV required.
 *
 * Usage:
 *   node scripts/backfill-fba-inbound-placement.js              # all sellers, 90d
 *   node scripts/backfill-fba-inbound-placement.js all 180      # all sellers, 180d
 *   node scripts/backfill-fba-inbound-placement.js <email> 90   # one seller
 *
 * Skips sellers whose snapshot is already finances_join/report and fresher
 * than --force unless force=true via env FBA_INBOUND_PLACEMENT_FORCE=true
 * or argv includes "force".
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  const args = process.argv.slice(2).filter(Boolean);
  const force = args.includes('force')
    || process.env.FBA_INBOUND_PLACEMENT_FORCE === 'true';
  const filtered = args.filter((a) => a !== 'force');
  const sellerKey = filtered[0] && filtered[0] !== 'all' ? filtered[0] : null;
  const days = Number(filtered[sellerKey ? 1 : 0]) || 90;

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI / MONGO_URI missing');
  await mongoose.connect(uri, { dbName: process.env.MONGO_DB_NAME || undefined });

  const User = require('../src/models/User');
  const FbaInboundPlacementFee = require('../src/models/FbaInboundPlacementFee');
  const {
    syncFbaInboundPlacementFees,
  } = require('../src/services/fbaInboundPlacementSyncService');

  let users;
  if (sellerKey) {
    const one = mongoose.isValidObjectId(sellerKey)
      ? await User.findById(sellerKey)
      : await User.findOne({
        email: new RegExp(sellerKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      });
    users = one ? [one] : [];
  } else {
    users = await User.find({
      amazonRefreshToken: { $exists: true, $nin: [null, ''] },
    }).lean();
  }

  console.log(
    `Backfilling inbound placement for ${users.length} seller(s), days=${days}, force=${force}`,
  );

  const summary = [];
  for (const user of users) {
    const email = user.email || String(user._id);
    const before = await FbaInboundPlacementFee.findOne(
      { sellerId: user._id },
      { source: 1, updatedAt: 1 },
    ).lean();

    // Soft-skip already-migrated fresh API snapshots unless force.
    if (
      !force
      && before
      && (before.source === 'finances_join' || before.source === 'report')
      && before.updatedAt
      && (Date.now() - before.updatedAt.getTime()) < 24 * 3_600_000
    ) {
      console.log(`[skip] ${email} source=${before.source} fresh`);
      summary.push({ email, skipped: true, source: before.source });
      continue;
    }

    const t0 = Date.now();
    console.log(`[start] ${email} priorSource=${before?.source || 'none'}`);
    try {
      const result = await syncFbaInboundPlacementFees(user, {
        force: true,
        days,
      });
      const doc = await FbaInboundPlacementFee.findOne(
        { sellerId: user._id },
      ).lean();
      const byMonth = {};
      for (const ev of doc?.events || []) {
        const m = String(ev.transaction_date || '').slice(0, 7);
        if (!m) continue;
        byMonth[m] = (byMonth[m] || 0) + Number(ev.fee_total || 0);
      }
      console.log(
        `[done] ${email} in ${Date.now() - t0}ms`,
        result,
        'months=',
        byMonth,
      );
      summary.push({
        email,
        success: result.success,
        source: result.source,
        events: result.events,
        windowEvents: result.windowEvents,
        byMonth,
      });
    } catch (err) {
      console.error(`[fail] ${email}:`, err.message);
      summary.push({ email, success: false, error: err.message });
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
