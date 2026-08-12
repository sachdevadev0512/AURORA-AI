const crypto = require('crypto');

const PURPOSE_SALTS = {
  token: 'aurora-token-enc:',
  'seller-app': 'aurora-seller-app-enc:',
};

function decodeConfiguredKey(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;

  try {
    const fromBase64 = Buffer.from(trimmed, 'base64');
    if (fromBase64.length === 32) {
      return fromBase64;
    }
  } catch {
    // Fall through to legacy passphrase handling.
  }

  // Legacy deployments may store a long passphrase instead of base64 bytes.
  return crypto.createHash('sha256').update(`aurora-env-key:${trimmed}`).digest();
}

function resolveEncryptionKey(purpose = 'token') {
  const envPriority =
    purpose === 'seller-app'
      ? ['SELLER_APP_ENCRYPTION_KEY', 'TOKEN_ENCRYPTION_KEY']
      : ['TOKEN_ENCRYPTION_KEY', 'SELLER_APP_ENCRYPTION_KEY'];

  for (const envName of envPriority) {
    const key = decodeConfiguredKey(process.env[envName]);
    if (key) return key;
  }

  if (process.env.NODE_ENV !== 'production') {
    const secret = process.env.JWT_SECRET || 'aurora-dev-insecure-key';
    const salt = PURPOSE_SALTS[purpose] || PURPOSE_SALTS.token;
    return crypto.createHash('sha256').update(`${salt}${secret}`).digest();
  }

  return null;
}

function isConfiguredEncryptionKey(raw) {
  if (!raw) return false;
  try {
    return Buffer.from(String(raw).trim(), 'base64').length === 32;
  } catch {
    return false;
  }
}

module.exports = {
  decodeConfiguredKey,
  resolveEncryptionKey,
  isConfiguredEncryptionKey,
};
