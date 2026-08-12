const rateLimit = require('express-rate-limit');
const { createMongoRateLimitStore } = require('../stores/mongoRateLimitStore');

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function useMongoRateLimitStore() {
  return String(process.env.RATE_LIMIT_STORE || 'mongo').toLowerCase() !== 'memory';
}

function createLimiter({
  windowMs,
  max,
  message,
  storePrefix,
  standardHeaders = true,
  legacyHeaders = false,
}) {
  const options = {
    windowMs,
    max,
    standardHeaders,
    legacyHeaders,
    message: {
      success: false,
      error: message,
    },
  };

  if (useMongoRateLimitStore()) {
    options.store = createMongoRateLimitStore(storePrefix);
  } else if (process.env.NODE_ENV === 'production') {
    console.error(
      `[RateLimit] RATE_LIMIT_STORE=memory for "${storePrefix}" — limits are per-process only and will not be shared across instances.`,
    );
  }

  return rateLimit(options);
}

const apiLimiter = createLimiter({
  storePrefix: 'api',
  windowMs: toNumber(process.env.RATE_LIMIT_API_WINDOW_MS, 15 * 60 * 1000),
  max: toNumber(process.env.RATE_LIMIT_API_MAX, 600),
  message: 'Too many requests. Please try again shortly.',
});

const authLimiter = createLimiter({
  storePrefix: 'auth',
  windowMs: toNumber(process.env.RATE_LIMIT_AUTH_WINDOW_MS, 15 * 60 * 1000),
  max: toNumber(process.env.RATE_LIMIT_AUTH_MAX, 30),
  message: 'Too many authentication requests. Please wait and retry.',
});

const authLoginLimiter = createLimiter({
  storePrefix: 'auth-login',
  windowMs: toNumber(process.env.RATE_LIMIT_LOGIN_WINDOW_MS, 15 * 60 * 1000),
  max: toNumber(process.env.RATE_LIMIT_LOGIN_MAX, 10),
  message: 'Too many login attempts. Please wait before trying again.',
});

const oauthCallbackLimiter = createLimiter({
  storePrefix: 'oauth-callback',
  windowMs: toNumber(process.env.RATE_LIMIT_OAUTH_WINDOW_MS, 10 * 60 * 1000),
  max: toNumber(process.env.RATE_LIMIT_OAUTH_MAX, 50),
  message: 'Too many OAuth callback requests. Please retry shortly.',
});

const syncLimiter = createLimiter({
  storePrefix: 'sync',
  windowMs: toNumber(process.env.RATE_LIMIT_SYNC_WINDOW_MS, 10 * 60 * 1000),
  max: toNumber(process.env.RATE_LIMIT_SYNC_MAX, 25),
  message: 'Too many sync requests. Please wait before starting another sync.',
});

module.exports = {
  apiLimiter,
  authLimiter,
  authLoginLimiter,
  oauthCallbackLimiter,
  syncLimiter,
};
