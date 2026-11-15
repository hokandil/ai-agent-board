import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encrypt,
  decrypt,
  isEncrypted,
  isEncryptionConfigured,
} from '../src/services/credential-encryption.js';
import { credentialService } from '../src/services/credential-service.js';

function generateKey(): string {
  return crypto.randomBytes(32).toString('base64');
}

const crypto = await import('node:crypto');

test('credential encryption round-trip', () => {
  process.env.MCP_ENCRYPTION_KEY = generateKey();
  const plaintext = JSON.stringify({ api_key: 'sk-1234567890abcdef', token: 'my-secret' });

  const encrypted = encrypt(plaintext);
  assert.ok(encrypted, 'encrypt should return a value when key is configured');
  assert.notEqual(encrypted, plaintext, 'encrypted should differ from plaintext');

  const decrypted = decrypt(encrypted);
  assert.equal(decrypted, plaintext, 'decrypt should recover original plaintext');

  assert.ok(isEncrypted(encrypted), 'isEncrypted should recognize the envelope');
  assert.ok(!isEncrypted(plaintext), 'isEncrypted should reject plaintext');
});

test('credential encryption without key falls back gracefully', () => {
  delete process.env.MCP_ENCRYPTION_KEY;
  assert.equal(isEncryptionConfigured(), false);

  const plaintext = 'some secret value';
  assert.equal(encrypt(plaintext), null, 'encrypt should return null without key');
  assert.equal(decrypt(plaintext), null, 'decrypt should return null without key');
  assert.equal(isEncrypted(plaintext), false, 'isEncrypted should return false for plaintext without key');
});

test('redactCredentials masks values but preserves keys', () => {
  const creds = { api_key: 'sk-1234567890abcdef', authorization: 'Bearer token123', other: 'visible' };
  const redacted = credentialService.redactCredentials(creds);

  assert.equal(redacted.api_key, '[REDACTED]');
  assert.equal(redacted.authorization, '[REDACTED]');
  assert.equal(redacted.other, '[REDACTED]');
  assert.deepEqual(Object.keys(redacted).sort(), ['api_key', 'authorization', 'other'].sort());
});

test('redactCredentials handles empty object', () => {
  const redacted = credentialService.redactCredentials({});
  assert.deepEqual(redacted, {});
});

test('decrypt rejects tampered ciphertext', () => {
  process.env.MCP_ENCRYPTION_KEY = generateKey();
  const plaintext = JSON.stringify({ secret: 'value' });
  const encrypted = encrypt(plaintext);
  assert.ok(encrypted);

  // Tamper with the ciphertext
  const parsed = JSON.parse(encrypted) as { ciphertext: string; iv: string; salt: string; tag: string; version: number; algorithm: string };
  parsed.ciphertext = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

  const result = decrypt(JSON.stringify(parsed));
  assert.equal(result, null, 'decrypt should return null for tampered ciphertext');
});

test('decrypt rejects malformed envelope', () => {
  process.env.MCP_ENCRYPTION_KEY = generateKey();
  assert.equal(decrypt('not-json'), null);
  assert.equal(decrypt('{}'), null);
  assert.equal(decrypt('{"version":1}'), null);
});

test('encryptCredentials and decryptCredentials round-trip', () => {
  process.env.MCP_ENCRYPTION_KEY = generateKey();
  const creds = { api_key: 'sk-live-abc123', x_custom_header: 'header-value' };

  const encrypted = credentialService.encryptCredentials(creds);
  assert.ok(encrypted);

  const decrypted = credentialService.decryptCredentials(encrypted);
  assert.ok(decrypted);
  assert.equal(decrypted?.api_key, 'sk-live-abc123');
  assert.equal(decrypted?.x_custom_header, 'header-value');
});

test('decryptCredentials returns null for plaintext input when encryption configured', () => {
  process.env.MCP_ENCRYPTION_KEY = generateKey();
  const plaintextJson = JSON.stringify({ foo: 'bar' });
  const result = credentialService.decryptCredentials(plaintextJson);
  assert.equal(result, undefined, 'plaintext should not be treated as encrypted');
});

test('isValueEncrypted detects encrypted envelopes', () => {
  process.env.MCP_ENCRYPTION_KEY = generateKey();
  const encrypted = encrypt(JSON.stringify({ secret: 'x' }));
  assert.ok(encrypted);
  assert.ok(credentialService.isValueEncrypted(encrypted));
  assert.equal(credentialService.isValueEncrypted('{"foo":"bar"}'), false);
  assert.equal(credentialService.isValueEncrypted(''), false);
});

test('cleanup env', () => {
  delete process.env.MCP_ENCRYPTION_KEY;
});
