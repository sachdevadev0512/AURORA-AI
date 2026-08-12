function parseExportLimit(value, fallback = 0) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function exportLimitExceeded(count, limit) {
  return limit > 0 && count > limit;
}

function mongoExportLimit(limit) {
  return limit > 0 ? limit : 0;
}

module.exports = {
  parseExportLimit,
  exportLimitExceeded,
  mongoExportLimit,
};
