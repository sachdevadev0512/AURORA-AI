const crypto = require('crypto');
const { resolveEncryptionKey } = require('./encryptionKey');

const ENCRYPTED_PREFIX = 'enc:v1:';

function getEncryptionKey() {
  return resolveEncryptionKey('token');
}

function isEncryptedValue(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

function encryptField(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;
  if (isEncryptedValue(plaintext)) return plaintext;

  const key = getEncryptionKey();
  if (!key) return plaintext;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptField(value) {
  if (value == null || value === '') return value;
  if (!isEncryptedValue(value)) return value;

  const key = getEncryptionKey();
  if (!key) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is required to decrypt encrypted Amazon tokens. Generate one with: openssl rand -base64 32',
    );
  }

  const payload = value.slice(ENCRYPTED_PREFIX.length);
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Encrypted field has an invalid format');
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

function encryptUpdateFields(update, fields) {
  if (!update || !fields?.length) return;

  const targets = [update];
  if (update.$set && typeof update.$set === 'object') {
    targets.push(update.$set);
  }

  for (const target of targets) {
    for (const field of fields) {
      if (target[field] != null && target[field] !== '' && !isEncryptedValue(target[field])) {
        target[field] = encryptField(target[field]);
      }
    }
  }
}

function decryptDocumentFields(doc, fields) {
  if (!doc || !fields?.length) return;

  for (const field of fields) {
    if (doc[field]) {
      doc[field] = decryptField(doc[field]);
    }
  }
}

module.exports = {
  ENCRYPTED_PREFIX,
  encryptField,
  decryptField,
  isEncryptedValue,
  encryptUpdateFields,
  decryptDocumentFields,
};
