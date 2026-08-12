const DEFAULT_TTL_MS = Math.max(
  0,
  Number(process.env.READ_RESPONSE_CACHE_TTL_MS || 30_000),
);

const cache = new Map();

function isEnabled() {
  return DEFAULT_TTL_MS > 0;
}

function buildKey(namespace, sellerId, parts) {
  return `${namespace}:${String(sellerId)}:${parts}`;
}

function get(namespace, sellerId, parts) {
  if (!isEnabled()) return null;
  const key = buildKey(namespace, sellerId, parts);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function set(namespace, sellerId, parts, value, ttlMs = DEFAULT_TTL_MS) {
  if (!isEnabled()) return value;
  const key = buildKey(namespace, sellerId, parts);
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
  return value;
}

function invalidateSeller(namespace, sellerId) {
  const prefix = `${namespace}:${String(sellerId)}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

module.exports = {
  get,
  set,
  invalidateSeller,
  isEnabled,
};
