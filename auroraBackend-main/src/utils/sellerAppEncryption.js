const crypto = require('crypto');
const { resolveEncryptionKey } = require('./encryptionKey');

const SELLER_APP_ENCRYPTED_PATTERN = /^[0-9a-f]{32}:[0-9a-f]+$/i;

function getSellerAppEncryptionKey() {
  return resolveEncryptionKey('seller-app');
}

function isSellerAppEncryptedValue(value) {
  return typeof value === 'string' && SELLER_APP_ENCRYPTED_PATTERN.test(value);
}

function encryptSellerAppCredential(text) {
  if (text == null || text === '') return text;
  if (isSellerAppEncryptedValue(text)) return text;

  const key = getSellerAppEncryptionKey();
  if (!key) return text;

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSellerAppCredential(text) {
  if (text == null || text === '') return text;
  if (!isSellerAppEncryptedValue(text)) return text;

  const key = getSellerAppEncryptionKey();
  if (!key) {
    throw new Error(
      'SELLER_APP_ENCRYPTION_KEY (or TOKEN_ENCRYPTION_KEY) is required to decrypt seller application credentials.',
    );
  }

  const [ivHex, ciphertextHex] = text.split(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

module.exports = {
  encryptSellerAppCredential,
  decryptSellerAppCredential,
  isSellerAppEncryptedValue,
};
