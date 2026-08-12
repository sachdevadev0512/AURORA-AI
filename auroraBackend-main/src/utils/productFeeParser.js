const FEE_AMOUNT_EPSILON = 0.005;

const FEE_LABELS = {
  totalFees: 'Total Amazon fees',
  fbaFee: 'FBA fulfillment fee',
  Commission: 'Referral fee (Commission)',
  ReferralFee: 'Referral fee',
  FBAPerUnitFulfillmentFee: 'FBA per-unit fulfillment fee',
  FBAPerOrderFulfillmentFee: 'FBA per-order fulfillment fee',
  FBAFees: 'FBA fulfillment fee',
  VariableClosingFee: 'Variable closing fee',
  FixedClosingFee: 'Fixed closing fee',
  ShippingChargeback: 'Shipping chargeback',
  GiftwrapChargeback: 'Gift wrap chargeback',
  DigitalServicesFee: 'Digital services fee',
};

function money(amount = 0, currency = 'USD') {
  return {
    amount: Number(amount) || 0,
    currency: currency || 'USD',
  };
}

function moneyAmount(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const amount = Number(value.amount ?? value);
  return Number.isFinite(amount) ? amount : null;
}

function amountsEqual(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) < FEE_AMOUNT_EPSILON;
}

function formatFeeLabel(feeType) {
  if (FEE_LABELS[feeType]) return FEE_LABELS[feeType];
  return String(feeType || 'Fee')
    .replace(/([A-Z])/g, ' $1')
    .trim();
}

function formatMoney(amount, currency = 'USD') {
  const value = Number(amount) || 0;
  return `${currency} ${value.toFixed(2)}`;
}

function parseFeesEstimate(feesResponse) {
  const estimate =
    feesResponse?.payload?.FeesEstimateResult?.FeesEstimate ||
    feesResponse?.FeesEstimateResult?.FeesEstimate ||
    feesResponse?.feesEstimate;

  if (!estimate) {
    return {
      totalFees: money(0),
      referralFee: money(0),
      fbaFee: money(0),
      breakdown: [],
    };
  }

  const currency =
    estimate.TotalFeesEstimate?.CurrencyCode ||
    estimate.totalFeesEstimate?.currencyCode ||
    'USD';

  const total =
    estimate.TotalFeesEstimate?.Amount ??
    estimate.totalFeesEstimate?.amount ??
    0;

  const feeDetails = estimate.FeeDetailList || estimate.feeDetailList || [];
  const breakdown = [];
  let fbaFee = 0;
  let referralFee = 0;

  for (const fee of feeDetails) {
    const feeType = fee.FeeType || fee.feeType;
    const amount = fee.FeeAmount?.Amount ?? fee.feeAmount?.amount ?? 0;
    const feeCurrency =
      fee.FeeAmount?.CurrencyCode || fee.feeAmount?.currencyCode || currency;
    const parsed = Number(amount) || 0;

    if (!feeType) continue;
    breakdown.push({
      feeType: String(feeType),
      amount: parsed,
      currency: feeCurrency,
    });

    const typeLower = String(feeType).toLowerCase();
    if (typeLower.includes('fba') || typeLower.includes('fulfillment')) {
      fbaFee += parsed;
    }
    if (
      typeLower === 'commission'
      || typeLower === 'referralfee'
      || typeLower.includes('referral')
    ) {
      referralFee += parsed;
    }
  }

  return {
    totalFees: money(total, currency),
    referralFee: money(referralFee, currency),
    fbaFee: money(fbaFee, currency),
    breakdown,
  };
}

function referralFeeFromBreakdown(breakdown = [], currency = 'USD') {
  let referralFee = 0;
  for (const entry of breakdown) {
    const typeLower = String(entry?.feeType || '').toLowerCase();
    if (
      typeLower === 'commission'
      || typeLower === 'referralfee'
      || typeLower.includes('referral')
    ) {
      referralFee += Number(entry.amount) || 0;
    }
  }
  return money(referralFee, currency);
}

function resolveProductReferralFee(fees = {}) {
  const stored = moneyAmount(fees.referralFee);
  if (stored !== null && stored > 0) {
    return fees.referralFee;
  }
  return referralFeeFromBreakdown(
    fees.breakdown,
    fees.totalFees?.currency || fees.fbaFee?.currency || 'USD',
  );
}

function buildFeeSnapshot(product) {
  const snapshot = new Map();
  const fees = product?.fees || {};

  for (const entry of fees.breakdown || []) {
    if (!entry?.feeType) continue;
    snapshot.set(entry.feeType, {
      feeType: entry.feeType,
      amount: moneyAmount(entry.amount),
      currency: entry.currency || fees.totalFees?.currency || 'USD',
    });
  }

  if (moneyAmount(fees.totalFees) !== null) {
    snapshot.set('totalFees', {
      feeType: 'totalFees',
      amount: moneyAmount(fees.totalFees),
      currency: fees.totalFees?.currency || 'USD',
    });
  }

  if (moneyAmount(fees.fbaFee) !== null) {
    snapshot.set('fbaFee', {
      feeType: 'fbaFee',
      amount: moneyAmount(fees.fbaFee),
      currency: fees.fbaFee?.currency || 'USD',
    });
  }

  const referralFee = resolveProductReferralFee(fees);
  if (moneyAmount(referralFee) !== null) {
    snapshot.set('referralFee', {
      feeType: 'referralFee',
      amount: moneyAmount(referralFee),
      currency: referralFee?.currency || 'USD',
    });
  }

  return snapshot;
}

function buildFeeSnapshotFromEstimate(fees) {
  const snapshot = new Map();

  for (const entry of fees?.breakdown || []) {
    if (!entry?.feeType) continue;
    snapshot.set(entry.feeType, {
      feeType: entry.feeType,
      amount: moneyAmount(entry.amount),
      currency: entry.currency || fees.totalFees?.currency || 'USD',
    });
  }

  if (moneyAmount(fees?.totalFees) !== null) {
    snapshot.set('totalFees', {
      feeType: 'totalFees',
      amount: moneyAmount(fees.totalFees),
      currency: fees.totalFees.currency,
    });
  }

  if (moneyAmount(fees?.fbaFee) !== null) {
    snapshot.set('fbaFee', {
      feeType: 'fbaFee',
      amount: moneyAmount(fees.fbaFee),
      currency: fees.fbaFee.currency,
    });
  }

  const referralFee = resolveProductReferralFee(fees || {});
  if (moneyAmount(referralFee) !== null) {
    snapshot.set('referralFee', {
      feeType: 'referralFee',
      amount: moneyAmount(referralFee),
      currency: referralFee?.currency || 'USD',
    });
  }

  return snapshot;
}

function hasPriorProductFees(product) {
  const snapshot = buildFeeSnapshot(product);
  for (const fee of snapshot.values()) {
    if (fee.amount !== null && fee.amount > 0) return true;
  }
  return false;
}

function diffProductFees(existingProduct, newFees) {
  if (!existingProduct) return [];

  const oldSnapshot = buildFeeSnapshot(existingProduct);
  const newSnapshot = buildFeeSnapshotFromEstimate(newFees);
  const keys = new Set([...oldSnapshot.keys(), ...newSnapshot.keys()]);
  const changes = [];

  for (const feeType of keys) {
    const oldFee = oldSnapshot.get(feeType);
    const newFee = newSnapshot.get(feeType);
    const asin = existingProduct.asin;
    const sku = existingProduct.sku;
    const currencyCode =
      newFee?.currency || oldFee?.currency || newFees?.totalFees?.currency || 'USD';

    const oldAmount = oldFee?.amount ?? null;
    const newAmount = newFee?.amount ?? null;

    if (oldAmount === null && newAmount !== null && newAmount > 0) {
      changes.push({
        asin,
        sku,
        feeType,
        feeLabel: formatFeeLabel(feeType),
        changeType: 'added',
        oldAmount: null,
        newAmount,
        currencyCode,
      });
      continue;
    }

    if (oldAmount !== null && oldAmount > 0 && (newAmount === null || newAmount === 0)) {
      changes.push({
        asin,
        sku,
        feeType,
        feeLabel: formatFeeLabel(feeType),
        changeType: 'removed',
        oldAmount,
        newAmount: newAmount ?? 0,
        currencyCode,
      });
      continue;
    }

    if (
      oldAmount !== null &&
      newAmount !== null &&
      !amountsEqual(oldAmount, newAmount)
    ) {
      changes.push({
        asin,
        sku,
        feeType,
        feeLabel: formatFeeLabel(feeType),
        changeType: 'changed',
        oldAmount,
        newAmount,
        currencyCode,
      });
    }
  }

  return changes;
}

module.exports = {
  money,
  parseFeesEstimate,
  resolveProductReferralFee,
  hasPriorProductFees,
  diffProductFees,
  formatFeeLabel,
  formatMoney,
};
