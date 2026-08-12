import { Product } from '../types';

const AMAZON_STOREFRONT: Record<string, string> = {
  NA: 'https://www.amazon.com',
  EU: 'https://www.amazon.co.uk',
  FE: 'https://www.amazon.co.jp',
};

export function buildAmazonListingUrl(
  asin: string,
  marketplace?: string | null,
): string | null {
  const trimmed = String(asin || '').trim();
  if (!trimmed) return null;
  const base = AMAZON_STOREFRONT[String(marketplace || 'NA').toUpperCase()] || AMAZON_STOREFRONT.NA;
  return `${base}/dp/${encodeURIComponent(trimmed)}`;
}

export function getProductPrimaryImage(product: Product): string | null {
  const url = product.images?.[0]?.url;
  return url ? String(url) : null;
}
