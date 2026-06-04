import crypto from 'crypto';

/**
 * Webhook signing-secret storage (PRD §Key Decisions).
 *
 * Unlike OAuth client secrets (bcrypt-hashed in oauth/apps.ts — verified once,
 * never recovered), a webhook signing secret must be recoverable in plaintext
 * because every outbound delivery HMAC-signs the body with it. So we store the
 * secret encrypted (AES-256-GCM) plus a one-way `secret_fingerprint` for
 * display/audit. The raw secret is surfaced to the developer exactly once, on
 * create and rotation.
 *
 * The encryption key comes from the `WEBHOOK_SECRET_ENC_KEY` env var (32 bytes,
 * supplied as 64 hex chars or base64). It is read lazily so the suite and the
 * dev script can set it before the first encrypt/decrypt.
 */

const ENC_KEY_ENV = 'WEBHOOK_SECRET_ENC_KEY';
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16; // GCM auth tag length

let cachedKey: Buffer | null = null;

/** Resolve and validate the 32-byte AES key from the environment (cached). */
function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env[ENC_KEY_ENV];
  if (!raw) {
    throw new Error(
      `${ENC_KEY_ENV} is not set. Webhook signing secrets cannot be encrypted without it. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  // Accept either 64 hex chars or base64 (both decode to 32 bytes).
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`${ENC_KEY_ENV} must decode to 32 bytes (got ${key.length}). Provide 64 hex chars or base64.`);
  }
  cachedKey = key;
  return key;
}

/** Test seam: forget the cached key so a test can swap the env var mid-suite. */
export function resetEncryptionKeyCache(): void {
  cachedKey = null;
}

/** A high-entropy signing secret, surfaced once on create/rotation. */
export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString('base64url')}`;
}

/**
 * AES-256-GCM encrypt. Returns base64(iv | authTag | ciphertext) so the IV and
 * tag travel with the ciphertext and a fresh random IV is used every call.
 */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Reverse of {@link encryptSecret}. Throws if the payload is malformed or tampered. */
export function decryptSecret(stored: string): string {
  const buf = Buffer.from(stored, 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error('encrypted webhook secret is too short to be valid');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Non-secret fingerprint for display/audit (e.g. `sha256:ab12…`). Lets the
 * portal show which secret is active without ever exposing it.
 */
export function secretFingerprint(plaintext: string): string {
  return `sha256:${crypto.createHash('sha256').update(plaintext).digest('hex')}`;
}
