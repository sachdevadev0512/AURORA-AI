const MAX_SEARCH_LENGTH = 200;
const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

function escapeRegexLiteral(value) {
  return String(value ?? '').replace(REGEX_SPECIAL_CHARS, '\\$&');
}

function normalizeSearchInput(search, maxLength = MAX_SEARCH_LENGTH) {
  const normalized = String(search ?? '').trim();
  if (!normalized) return '';
  return normalized.slice(0, maxLength);
}

function buildCaseInsensitiveRegex(search, maxLength = MAX_SEARCH_LENGTH) {
  const normalized = normalizeSearchInput(search, maxLength);
  if (!normalized) return null;
  return new RegExp(escapeRegexLiteral(normalized), 'i');
}

function buildExactCaseInsensitiveRegex(search, maxLength = MAX_SEARCH_LENGTH) {
  const normalized = normalizeSearchInput(search, maxLength);
  if (!normalized) return null;
  return new RegExp(`^${escapeRegexLiteral(normalized)}$`, 'i');
}

function buildMongoRegexFilter(search, maxLength = MAX_SEARCH_LENGTH) {
  const normalized = normalizeSearchInput(search, maxLength);
  if (!normalized) return null;
  return { $regex: escapeRegexLiteral(normalized), $options: 'i' };
}

module.exports = {
  MAX_SEARCH_LENGTH,
  escapeRegexLiteral,
  normalizeSearchInput,
  buildCaseInsensitiveRegex,
  buildExactCaseInsensitiveRegex,
  buildMongoRegexFilter,
};
