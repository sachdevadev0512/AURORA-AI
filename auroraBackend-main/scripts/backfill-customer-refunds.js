/**
 * Backfill refund data onto existing orders for connected sellers.
 *
 * Usage:
 *   node scripts/backfill-customer-refunds.js                # all sellers, 180d
 *   node scripts/backfill-customer-refunds.js all 180        # all sellers, 180d
 *   node scripts/backfill-customer-refunds.js <email> [days] # one seller
 *
 * Captures DEFERRED "Refund applied" rows via listTransactions (Finances
 * 2024-06-19). Finances history beyond ~180d is not available via API.
 *
 * Tip: leave REFUNDS_INCLUDE_V0 unset so busy accounts stay on listTransactions
 * only (v0 walks are slow and duplicate DEFERRED→RELEASED rows).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const AmazonAPI = require('../src/utils/amazonAPI');
const { getSellerAppCredentials } = require('../src/utils/sellerAppHelper');
const { syncCustomerRefunds } = require('../src/services/customerRefundsService');

(async () => {
  const args = process.argv.slice(2).filter(Boolean);
  let sellerKey = null;
  // Amazon Finances listTransactions typically covers ~180 days — use that for
  // one-time "all available" backfills unless the caller narrows it.
  let days = 180;
  if (args[0] && args[0] !== 'all' && !/^\d+$/.test(args[0])) {
    sellerKey = args[0];
    days = Number(args[1]) || 180;
  } else if (args[0] === 'all') {
    days = Number(args[1]) || 180;
  } else if (args[0] && /^\d+$/.test(args[0])) {
    days = Number(args[0]) || 180;
  }

  // Cap pages high enough for a 180d window on busy accounts (500 txs/page).
  if (!process.env.REFUNDS_TX_MAX_PAGES) {
    process.env.REFUNDS_TX_MAX_PAGES = '200';
  }

  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME || undefined,
  });
  const User = require('../src/models/User');

  let users;
  if (sellerKey) {
    const one = mongoose.isValidObjectId(sellerKey)
      ? await User.findById(sellerKey)
      : await User.findOne({
        email: new RegExp(sellerKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      });
    users = one ? [one] : [];
  } else {
    users = await User.find({ amazonRefreshToken: { $exists: true, $nin: [null, ''] } })
      .select('_id email amazonRefreshToken amazonSellerId')
      .lean();
  }

  console.log(`Backfilling refunds for ${users.length} seller(s), lookback=${days}d`);

  const start = new Date();
  start.setUTCDate(start.getUTCDate() - days);
  const startIso = start.toISOString();

  let ok = 0;
  let failed = 0;
  let totalUpdated = 0;

  for (let i = 0; i < users.length; i += 1) {
    const user = users[i];
    const label = user.email || String(user._id);
    console.log(`[${i + 1}/${users.length}] ${label}…`);
    try {
      // Re-hydrate as a mongoose doc so AmazonAPI / sync helpers work.
      const fullUser = await User.findById(user._id);
      const creds = await getSellerAppCredentials(fullUser._id);
      const amazonAPI = new AmazonAPI(fullUser, creds);
      const stats = await syncCustomerRefunds(fullUser, amazonAPI, startIso);
      ok += 1;
      totalUpdated += stats.updatedOrders || 0;
      console.log(
        `  OK refundEvents=${stats.refundEventCount} tx=${stats.txRefundCount || 0} ordersUpdated=${stats.updatedOrders}`,
      );
    } catch (error) {
      failed += 1;
      console.warn(`  FAILED — ${error.message}`);
    }
  }

  await mongoose.disconnect();
  console.log(`Done sellers_ok=${ok} failed=${failed} ordersUpdated=${totalUpdated}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
