const {
  encryptField,
  decryptField,
  isEncryptedValue,
} = require('../fieldEncryption');

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test', JWT_SECRET: 'test-jwt-secret-for-encryption-tests' };
  delete process.env.TOKEN_ENCRYPTION_KEY;
  delete process.env.SELLER_APP_ENCRYPTION_KEY;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

test('encrypts and decrypts Amazon-like refresh tokens', () => {
  const token =
    'Atzr|IwEBIJExample:MGUCMFrRsktMRVlWaOR70XGMFGLL0SlcCw4DiYveIiOVx1uK9BbD0gvAddsW3UTLozXKMgIxAJ3qxUvjpnlLIOaaKOoa';

  const encrypted = encryptField(token);
  expect(isEncryptedValue(encrypted)).toBe(true);
  expect(encrypted).not.toContain(token);
  expect(decryptField(encrypted)).toBe(token);
});

test('leaves legacy plaintext values readable until rewritten', () => {
  const legacy = 'plain-refresh-token-with:colon';
  expect(decryptField(legacy)).toBe(legacy);
});

test('does not double-encrypt values', () => {
  const token = 'sample-token';
  const encryptedOnce = encryptField(token);
  const encryptedTwice = encryptField(encryptedOnce);
  expect(encryptedTwice).toBe(encryptedOnce);
});
