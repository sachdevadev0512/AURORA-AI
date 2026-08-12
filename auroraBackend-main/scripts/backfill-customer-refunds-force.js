/**
 * Force refund sync for one seller (bypasses cooldown).
 * Usage: node scripts/backfill-customer-refunds-force.js <email> [days]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const AmazonAPI = require('../src/utils/amazonAPI');
const { getSellerAppCredentials } = require('../src/utils/sellerAppHelper');
const { syncCustomerRefunds } = require('../src/services/customerRefundsService');

const email = process.argv[2];
const days = Number(process.argv[3]) || 45;

(async () => {
  if (!email) {
    console.error('Usage: node scripts/backfill-customer-refunds-force.js <email> [days]');
    process.exit(1);
  }
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  await mongoose.connect(uri, { dbName: process.env.MONGO_DB_NAME || undefined });
  const User = require('../src/models/User');
  const user = await User.findOne({
    email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
  });
  if (!user?.amazonRefreshToken) throw new Error('user not found/connected');

  const start = new Date();
  start.setUTCDate(start.getUTCDate() - days);
  console.log(`Syncing refunds for ${user.email} lookback=${days}d from ${start.toISOString()}`);

  const api = new AmazonAPI(user, await getSellerAppCredentials(user._id));
  const result = await syncCustomerRefunds(user, api, start);
  console.log('result', result);

  const orderId = process.argv[4] || '111-5230199-4965029';
  const order = await mongoose.connection.collection('orders').findOne({
    sellerId: user._id,
    amazonOrderId: orderId,
  });
  console.log('order check', {
    amazonOrderId: orderId,
    hasRefund: order?.hasRefund,
    latestRefundDate: order?.latestRefundDate,
    refunds: order?.refunds,
  });

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
