/**
 * ETag / If-Match helpers for optimistic concurrency on REST mutations.
 */

function buildEntityTag(updatedAt) {
  if (!updatedAt) return null;
  const ms = new Date(updatedAt).getTime();
  if (!Number.isFinite(ms)) return null;
  return `"${ms}"`;
}

function parseIfMatchHeader(req) {
  const raw = req.headers['if-match'];
  if (!raw) return null;

  const token = String(raw)
    .trim()
    .replace(/^W\//, '')
    .replace(/^"/, '')
    .replace(/"$/, '');

  const ms = Number(token);
  return Number.isFinite(ms) ? ms : null;
}

function applyIfMatchFilter(filter, ifMatchMs) {
  if (ifMatchMs == null) return filter;
  return {
    ...filter,
    updatedAt: new Date(ifMatchMs),
  };
}

module.exports = {
  buildEntityTag,
  parseIfMatchHeader,
  applyIfMatchFilter,
};
