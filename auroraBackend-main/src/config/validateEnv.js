const crypto = require('crypto');
const { isConfiguredEncryptionKey } = require('../utils/encryptionKey');

const WEAK_JWT_SECRETS = new Set(
  [
    'your-super-secret-jwt-key-change-in-production',
    'your-super-secret-jwt-key',
    'your_jwt_secret_key_here',
    'jwt_secret',
    'secret',
    'changeme',
    'change-me',
    'test',
    'development',
  ].map((value) => value.toLowerCase()),
);

const MIN_JWT_SECRET_LENGTH = 32;

function normalizeSecret(value) {
  return String(value || '').trim();
}

function isWeakJwtSecret(secret) {
  const normalized = normalizeSecret(secret).toLowerCase();
  if (!normalized) return true;
  if (WEAK_JWT_SECRETS.has(normalized)) return true;
  if (normalized.length < MIN_JWT_SECRET_LENGTH) return true;
  if (/^(your|change|test|dev|demo|example|placeholder)/.test(normalized)) return true;
  return false;
}

function validateJwtSecret() {
  const secret = normalizeSecret(process.env.JWT_SECRET);
  const isProduction = process.env.NODE_ENV === 'production';

  if (!secret) {
    const message = 'JWT_SECRET is required. Generate one with: node scripts/generate-jwt-secret.js';
    if (isProduction) {
      throw new Error(message);
    }
    console.warn(`[Security] ${message}`);
    return;
  }

  if (isWeakJwtSecret(secret)) {
    const message =
      'JWT_SECRET is too weak. Use at least 32 random characters (recommended: 64-byte hex). ' +
      'Run: node scripts/generate-jwt-secret.js';
    if (isProduction) {
      throw new Error(message);
    }
    console.warn(`[Security] ${message}`);
    return;
  }

  if (isProduction && secret.length < 48) {
    throw new Error(
      'JWT_SECRET should be at least 48 characters in production. Run: node scripts/generate-jwt-secret.js',
    );
  }
}

function warnAboutEncryptionKey({ name, fallbackMessage }) {
  console.warn(`[Security] ${name} ${fallbackMessage}`);
}

function validateEncryptionEnvKey(name) {
  const raw = process.env[name];
  if (!raw) return;

  if (!isConfiguredEncryptionKey(raw)) {
    warnAboutEncryptionKey({
      name,
      fallbackMessage:
        'is set but not valid base64 for 32 bytes. A stable SHA-256 passphrase fallback is used. Prefer: openssl rand -base64 32',
    });
  }
}

function validateTokenEncryptionKey() {
  const tokenKey = process.env.TOKEN_ENCRYPTION_KEY;
  const sellerAppKey = process.env.SELLER_APP_ENCRYPTION_KEY;

  if (!tokenKey && !sellerAppKey) {
    warnAboutEncryptionKey({
      name: 'TOKEN_ENCRYPTION_KEY / SELLER_APP_ENCRYPTION_KEY',
      fallbackMessage:
        'are not set. Generate with: openssl rand -base64 32. In production, Amazon tokens and seller app secrets stay in plaintext until configured.',
    });
    return;
  }

  validateEncryptionEnvKey('TOKEN_ENCRYPTION_KEY');
  validateEncryptionEnvKey('SELLER_APP_ENCRYPTION_KEY');
}

function validateRequiredEnv() {
  validateJwtSecret();
  validateTokenEncryptionKey();
}

module.exports = {
  validateRequiredEnv,
  isWeakJwtSecret,
  generateJwtSecret: () => crypto.randomBytes(64).toString('hex'),
};
