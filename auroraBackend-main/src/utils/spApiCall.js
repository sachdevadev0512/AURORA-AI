const { sleep } = require('./async');

const DEFAULT_MIN_INTERVAL_MS = Math.max(
  0,
  Number(process.env.SP_API_MIN_INTERVAL_MS || 200),
);

const lastCallAt = new Map();

function parseRetryAfterMs(error) {
  const header =
    error?.response?.headers?.['retry-after'] ??
    error?.response?.headers?.['Retry-After'] ??
    error?.headers?.['retry-after'];
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function isThrottleError(error) {
  const status = error?.response?.status ?? error?.statusCode ?? error?.status;
  const message = String(error?.message || '');
  const code = String(error?.code || '');
  return (
    status === 429 ||
    status === 503 ||
    /throttl|quota|TooManyRequests|RateLimit|SlowDown/i.test(message) ||
    /throttl|quota|TooManyRequests|RateLimit/i.test(code)
  );
}

function buildSpApiLabel(baseLabel, params = {}) {
  const base = baseLabel || 'default';
  const op = params?.operation || params?.endpoint || 'call';
  return `${base}:${op}`;
}

async function waitForSpApiSlot(label = 'default') {
  const minInterval = DEFAULT_MIN_INTERVAL_MS;
  if (minInterval <= 0) return;

  const key = label || 'default';
  const now = Date.now();
  const last = lastCallAt.get(key) || 0;
  const waitMs = last + minInterval - now;
  if (waitMs > 0) await sleep(waitMs);
  lastCallAt.set(key, Date.now());
}

async function callWithSpApiRetry(fn, options = {}) {
  const {
    shouldAbort,
    label = 'default',
    maxAttempts = 5,
    baseDelayMs = 400,
  } = options;

  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (shouldAbort?.()) {
      const error = new Error('Sync aborted');
      error.code = 'SYNC_ABORTED';
      throw error;
    }

    await waitForSpApiSlot(label);

    try {
      return await fn();
    } catch (error) {
      if (error?.code === 'SYNC_ABORTED' || error?.message === 'Sync aborted') {
        throw error;
      }
      lastError = error;
      if (!isThrottleError(error) || attempt >= maxAttempts - 1) {
        throw error;
      }
      const retryAfter = parseRetryAfterMs(error);
      const delay = retryAfter ?? baseDelayMs * 2 ** attempt;
      await sleep(delay);
    }
  }

  throw lastError;
}

module.exports = {
  callWithSpApiRetry,
  isThrottleError,
  waitForSpApiSlot,
  buildSpApiLabel,
};
