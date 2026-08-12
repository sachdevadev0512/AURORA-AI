/**
 * Prefer the Seller Central "home" marketplace for a selling region.
 * amazonMarketplaceIds from getMarketplaceParticipations is unordered; using [0]
 * (often MX/BR) causes inventory/price sync to miss US listings.
 */

const REGION_PRIMARY_MARKETPLACE = {
  NA: 'ATVPDKIKX0DER', // US
  EU: 'A1PA6795UKMFR9', // DE
  FE: 'A1VC38T7YXB528', // JP
};

/** Prefer US → CA → MX within North America when the home ID is missing. */
const NA_FALLBACK_ORDER = [
  'ATVPDKIKX0DER', // US
  'A2EUQ1WTGCTBG2', // CA
  'A1AM78C64UM0Y8', // MX
];

function preferMarketplaceId(marketplaceIds, region = 'NA') {
  const list = [...new Set((marketplaceIds || []).filter(Boolean).map(String))];
  const primary = REGION_PRIMARY_MARKETPLACE[region] || REGION_PRIMARY_MARKETPLACE.NA;
  if (list.length === 0) return primary;
  if (list.includes(primary)) return primary;

  if ((region || 'NA') === 'NA') {
    for (const id of NA_FALLBACK_ORDER) {
      if (list.includes(id)) return id;
    }
  }

  return list[0];
}

function sortMarketplaceIds(marketplaceIds, region = 'NA') {
  const list = [...new Set((marketplaceIds || []).filter(Boolean).map(String))];
  if (list.length === 0) return [];
  const preferred = preferMarketplaceId(list, region);
  return [preferred, ...list.filter((id) => id !== preferred)];
}

module.exports = {
  REGION_PRIMARY_MARKETPLACE,
  preferMarketplaceId,
  sortMarketplaceIds,
};
