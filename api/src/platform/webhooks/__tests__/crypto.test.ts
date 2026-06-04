import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import {
  generateWebhookSecret,
  encryptSecret,
  decryptSecret,
  secretFingerprint,
  resetEncryptionKeyCache,
} from '../crypto.js';

describe('webhook secret crypto', () => {
  beforeAll(() => {
    // Lazy key resolution means setting this before the first call is enough.
    process.env.WEBHOOK_SECRET_ENC_KEY = crypto.randomBytes(32).toString('hex');
    resetEncryptionKeyCache();
  });

  it('round-trips encrypt → decrypt', () => {
    const secret = generateWebhookSecret();
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it('uses a fresh IV so ciphertexts differ for the same plaintext', () => {
    const secret = generateWebhookSecret();
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });

  it('generates a whsec_-prefixed secret', () => {
    expect(generateWebhookSecret()).toMatch(/^whsec_[A-Za-z0-9_-]+$/);
  });

  it('produces a stable, non-secret fingerprint', () => {
    const secret = generateWebhookSecret();
    const fp = secretFingerprint(secret);
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fp).toBe(secretFingerprint(secret));
    expect(fp).not.toContain(secret);
  });

  it('rejects tampered ciphertext (GCM auth)', () => {
    const encrypted = encryptSecret(generateWebhookSecret());
    const buf = Buffer.from(encrypted, 'base64');
    buf.writeUInt8(buf.readUInt8(buf.length - 1) ^ 0xff, buf.length - 1); // flip a ciphertext byte
    expect(() => decryptSecret(buf.toString('base64'))).toThrow();
  });

  it('rejects a too-short payload', () => {
    expect(() => decryptSecret(Buffer.from('short').toString('base64'))).toThrow();
  });
});
