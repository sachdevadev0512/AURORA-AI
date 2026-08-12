/**
 * Pick marketplace-scoped rows without falling back to an arbitrary marketplace.
 */

function pickMarketplaceRow(rows, marketplaceId, { idField = 'marketplaceId' } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (marketplaceId) {
    const exact = rows.find((row) => row?.[idField] === marketplaceId);
    if (exact) return exact;
  }
  return rows.find((row) => !row?.[idField]) || null;
}

module.exports = {
  pickMarketplaceRow,
};
