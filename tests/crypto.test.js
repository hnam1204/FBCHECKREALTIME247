const test = require('node:test');
const assert = require('node:assert/strict');
const { encrypt, decrypt, hash } = require('../src/utils/crypto');

const TEST_KEY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('Crypto: AES-256-GCM encryption and decryption roundtrip', () => {
  const secretToken = 'EAABwzLixnjYBA...meta_page_access_token_super_secret';
  const encrypted = encrypt(secretToken, TEST_KEY);

  assert.notEqual(encrypted, secretToken);
  assert.ok(encrypted.includes(':'));

  const decrypted = decrypt(encrypted, TEST_KEY);
  assert.equal(decrypted, secretToken);
});

test('Crypto: Tampered ciphertext fails decryption', () => {
  const secretToken = 'token123';
  const encrypted = encrypt(secretToken, TEST_KEY);
  const parts = encrypted.split(':');
  // Tamper with the ciphertext byte
  parts[2] = parts[2].slice(0, -2) + '00';
  const tampered = parts.join(':');

  assert.throws(() => {
    decrypt(tampered, TEST_KEY);
  });
});

test('Crypto: Hash generates deterministic sha256', () => {
  const h1 = hash('facebook_test_id');
  const h2 = hash('facebook_test_id');
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});
