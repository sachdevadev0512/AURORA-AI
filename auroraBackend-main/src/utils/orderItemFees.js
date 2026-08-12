/**
 * Real per-item order fees derived from `products.fees` (kept in sync with
 * Seller Central via the Fees API by productFeeLiveSync), replacing the old
 * hardcoded 15% referral / $2.50 FBA heuristics.
 *
 * - Referral scales with the sale price (rate = product referral / product
 *   price), so historical orders at different prices stay accurate.
 * - FBA fulfilment fee is fixed per unit, so it is per-unit * quantity.
 * - COGS uses repricer.unitCost when set; otherwise falls back to 60% of revenue.
 */

const { resolveProductReferralFee } = require('./productFeeParser');

const DEFAULT_REFERRAL_RATE = 0.15;

function amountOf(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const amount = Number(value.amount ?? value);
  return Number.isFinite(amount) ? amount : 0;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function buildSellerFeeMap(products = []) {
  const map = new Map();
  for (const product of products) {
    const sku = product?.sku;
    if (!sku) continue;

    const fees = product.fees || {};
    const price = amountOf(product.price);
    const referralPerUnit = amountOf(resolveProductReferralFee(fees));
    const fbaPerUnit = amountOf(fees.fbaFee);
    const totalPerUnit = amountOf(fees.totalFees);
    if (referralPerUnit <= 0 && fbaPerUnit <= 0 && totalPerUnit <= 0) continue;

    const resolvedReferral =
      referralPerUnit > 0
        ? referralPerUnit
        : totalPerUnit > fbaPerUnit
          ? totalPerUnit - fbaPerUnit
          : 0;

    map.set(sku, {
      referralPerUnit: resolvedReferral,
      referralRate: price > 0 && resolvedReferral > 0 ? resolvedReferral / price : null,
      fbaPerUnit,
      unitCost: Number(product.repricer?.unitCost) > 0 ? Number(product.repricer.unitCost) : null,
      currency: fees.totalFees?.currency || fees.fbaFee?.currency || 'USD',
    });
  }
  return map;
}

async function loadSellerFeeMap(sellerId, skus = null) {
  const Product = require('../models/Product');
  const query = { sellerId };
  if (Array.isArray(skus)) {
    if (skus.length === 0) return new Map();
    query.sku = { $in: skus };
  }
  const products = await Product.find(query)
    .select('sku price fees repricer.unitCost')
    .lean();
  return buildSellerFeeMap(products);
}

/**
 * @param {object} line { sku, quantity, lineTotal, currency, isFba }
 *   `lineTotal` is the full line revenue (Aurora stores itemPrice as line total).
 */
function computeItemFees(
  { sku, quantity, lineTotal, currency = 'USD', isFba = true },
  feeMap,
) {
  const qty = Math.max(1, Number(quantity) || 1);
  const revenue = Math.max(0, Number(lineTotal) || 0);
  const basis = feeMap?.get(sku);

  let referral;
  let fba;

  if (basis) {
    referral =
      basis.referralRate !== null && revenue > 0
        ? revenue * basis.referralRate
        : basis.referralPerUnit * qty;
    fba = isFba ? basis.fbaPerUnit * qty : 0;
  } else {
    referral = revenue * DEFAULT_REFERRAL_RATE;
    // Prefer $0 over inventing $2.50 when we have no Fees API basis.
    fba = 0;
  }

  const cogs = basis?.unitCost != null ? basis.unitCost * qty : revenue * 0.6;
  const currencyCode = basis?.currency || currency || 'USD';
  return {
    referralFee: { amount: round2(referral), currencyCode },
    fulfillmentFee: { amount: round2(fba), currencyCode },
    costOfGoodsSold: { amount: round2(cogs), currencyCode },
  };
}

module.exports = {
  buildSellerFeeMap,
  loadSellerFeeMap,
  computeItemFees,
};
