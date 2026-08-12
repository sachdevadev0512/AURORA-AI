/**
 * One-shot repair: recompute referralFee / fulfillmentFee / costOfGoodsSold /
 * itemSubtotal on every order line item, for every seller, from products.fees
 * (Fees API — matches Seller Central). Fixes the old 15%/$2.50 heuristic and
 * the quantity double-count from the report parser.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../src/models/Order');
const { loadSellerFeeMap, computeItemFees } = require('../src/utils/orderItemFees');

const BULK_SIZE = 500;

function amt(v) {
  return Number(v?.amount) || 0;
}

function near(a, b) {
  return Math.abs(a - b) < 0.005;
}

async function repairSeller(sellerId) {
  const feeMap = await loadSellerFeeMap(sellerId);
  console.log(`Seller ${sellerId}: fee basis for ${feeMap.size} SKUs`);

  const cursor = Order.find({ sellerId })
    .select('orderItems')
    .lean()
    .cursor();

  let scanned = 0;
  let updated = 0;
  let bulk = [];

  for await (const order of cursor) {
    scanned += 1;
    let changed = false;

    const items = (order.orderItems || []).map((item) => {
      const qty = Math.max(1, Number(item.quantityOrdered) || 1);
      const ip = amt(item.itemPrice);
      const sub = amt(item.itemSubtotal);

      // itemPrice (API + report paths) is the line total. When itemPrice was
      // wiped by a live update, the preserved report itemSubtotal is
      // lineTotal × qty, so divide the double-count back out.
      let lineTotal;
      if (ip > 0) {
        lineTotal = ip;
      } else if (sub > 0) {
        lineTotal = qty > 1 ? sub / qty : sub;
      } else {
        lineTotal = 0;
      }

      const currency =
        item.itemPrice?.currencyCode || item.itemSubtotal?.currencyCode || 'USD';
      const fees = computeItemFees(
        { sku: item.sellerSku, quantity: qty, lineTotal, currency },
        feeMap
      );

      const next = { ...item };
      if (!near(amt(item.referralFee), fees.referralFee.amount)) {
        next.referralFee = fees.referralFee;
        changed = true;
      }
      if (!near(amt(item.fulfillmentFee), fees.fulfillmentFee.amount)) {
        next.fulfillmentFee = fees.fulfillmentFee;
        changed = true;
      }
      if (!near(amt(item.costOfGoodsSold), fees.costOfGoodsSold.amount)) {
        next.costOfGoodsSold = fees.costOfGoodsSold;
        changed = true;
      }
      if (lineTotal > 0 && !near(sub, lineTotal)) {
        next.itemSubtotal = { amount: Math.round(lineTotal * 100) / 100, currencyCode: currency };
        changed = true;
      }
      return next;
    });

    if (changed) {
      updated += 1;
      bulk.push({
        updateOne: {
          filter: { _id: order._id },
          update: { $set: { orderItems: items } },
        },
      });
    }

    if (bulk.length >= BULK_SIZE) {
      await Order.bulkWrite(bulk, { ordered: false });
      bulk = [];
      process.stdout.write(`  scanned ${scanned}, updated ${updated}\r`);
    }
  }

  if (bulk.length > 0) {
    await Order.bulkWrite(bulk, { ordered: false });
  }
  console.log(`\nSeller ${sellerId}: scanned ${scanned}, repaired ${updated}`);
  return { scanned, updated };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const sellerIds = await Order.distinct('sellerId');
  console.log(`${sellerIds.length} sellers with orders`);

  let totalScanned = 0;
  let totalUpdated = 0;
  for (const sellerId of sellerIds) {
    const { scanned, updated } = await repairSeller(sellerId);
    totalScanned += scanned;
    totalUpdated += updated;
  }

  console.log(`DONE: ${totalUpdated}/${totalScanned} orders repaired`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
