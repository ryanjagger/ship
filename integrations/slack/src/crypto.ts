import crypto from 'node:crypto';

const KEY_ENV = 'SLACK_INTEGRATION_ENC_KEY';

let cachedKey: Buffer | null = null;

function resolveKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env[KEY_ENV];
  if (!raw) throw new Error(`${KEY_ENV} is required to encrypt Slack integration secrets`);

  const candidates = [
    Buffer.from(raw, 'hex'),
    Buffer.from(raw, 'base64'),
    Buffer.from(raw, 'utf8'),
  ];
  const key = candidates.find((candidate) => candidate.length === 32);
  if (!key) throw new Error(`${KEY_ENV} must decode to exactly 32 bytes`);
  cachedKey = key;
  return key;
}

export function encryptSecret(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', resolveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptSecret(value: string): string {
  const raw = Buffer.from(value, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', resolveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function resetEncryptionKeyForTests(): void {
  cachedKey = null;
}
