import { Product } from '../types';

type MoneyValue = { amount?: number; currency?: string };

function referralFromBreakdown(
  breakdown: Array<{ feeType?: string; amount?: number }> = [],
  currency = 'USD',
): MoneyValue {
  let amount = 0;
  for (const entry of breakdown) {
    const typeLower = String(entry.feeType || '').toLowerCase();
    if (
      typeLower === 'commission'
      || typeLower === 'referralfee'
      || typeLower.includes('referral')
    ) {
      amount += Number(entry.amount) || 0;
    }
  }
  return { amount, currency };
}

export function getProductReferralFee(product: Pick<Product, 'fees'>): MoneyValue | undefined {
  const fees = product.fees;
  if (!fees) return undefined;

  if (fees.referralFee && fees.referralFee.amount != null && fees.referralFee.amount > 0) {
    return fees.referralFee;
  }

  const fromBreakdown = referralFromBreakdown(
    fees.breakdown,
    fees.totalFees?.currency || fees.fbaFee?.currency || 'USD',
  );
  if (fromBreakdown.amount != null && fromBreakdown.amount > 0) {
    return fromBreakdown;
  }

  return fees.referralFee || fromBreakdown;
}

export function getProductFbaFee(product: Pick<Product, 'fees'>): MoneyValue | undefined {
  return product.fees?.fbaFee;
}

export function getProductTotalFees(product: Pick<Product, 'fees'>): MoneyValue | undefined {
  return product.fees?.totalFees;
}

export function formatProductFbaFee(product: Pick<Product, 'fees' | 'fulfillmentType'>): string {
  if (product.fulfillmentType === 'FBM') {
    return '—';
  }
  return formatProductFee(getProductFbaFee(product));
}

export function formatProductFee(
  value?: MoneyValue | null,
  options?: { hideZero?: boolean },
): string {
  if (!value || value.amount == null) return '—';
  if (options?.hideZero && value.amount <= 0) return '—';
  const currency = value.currency && value.currency !== 'USD' ? ` ${value.currency}` : '';
  return `$${value.amount.toFixed(2)}${currency}`;
}
