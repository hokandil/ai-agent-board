import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;

/** Shape of an encrypted value stored in the database. */
export interface EncryptedValue {
  algorithm: string;
  ciphertext: string;
  iv: string;
  salt: string;
  tag: string;
  version: number;
}

/** Returns true if the MCP_ENCRYPTION_KEY env var is configured. */
function hasEncryptionKey(): boolean {
  return Boolean(process.env.MCP_ENCRYPTION_KEY);
}

/** Derive an encryption key from the configured env var. Returns null if not configured. */
function getDerivedKey(salt: Buffer): Buffer | null {
  const keyB64 = process.env.MCP_ENCRYPTION_KEY;
  if (!keyB64) return null;
  let keyMaterial: Buffer;
  try {
    keyMaterial = Buffer.from(keyB64, 'base64');
  } catch {
    return null;
  }
  if (keyMaterial.length !== KEY_LENGTH) {
    console.error('[credential-encryption] MCP_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    return null;
  }
  return crypto.scryptSync(keyMaterial, salt, KEY_LENGTH);
}

/** Encrypt a UTF-8 string with authenticated encryption. Returns null if encryption is not configured. */
export function encrypt(value: string): string | null {
  if (!hasEncryptionKey()) return null;

  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getDerivedKey(salt);
  if (!key) return null;

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from('ai-agent-board-mcp-credentials', 'utf8'));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope: EncryptedValue = {
    algorithm: ALGORITHM,
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    salt: salt.toString('base64'),
    tag: tag.toString('base64'),
    version: 1,
  };
  return JSON.stringify(envelope);
}

/** Decrypt an encrypted value. Returns null if decryption fails or encryption is not configured. */
export function decrypt(encrypted: string): string | null {
  if (!hasEncryptionKey()) return null;

  let parsed: EncryptedValue;
  try {
    parsed = JSON.parse(encrypted) as EncryptedValue;
  } catch {
    return null;
  }

  if (
    !parsed ||
    parsed.version !== 1 ||
    parsed.algorithm !== ALGORITHM ||
    !parsed.ciphertext ||
    !parsed.iv ||
    !parsed.salt ||
    !parsed.tag
  ) {
    return null;
  }

  const key = getDerivedKey(Buffer.from(parsed.salt, 'base64'));
  if (!key) return null;

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(parsed.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from('ai-agent-board-mcp-credentials', 'utf8'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

/** Returns true if a string appears to be an encrypted envelope produced by this module. */
export function isEncrypted(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = JSON.parse(value) as Partial<EncryptedValue>;
    return (
      Boolean(parsed) &&
      parsed.version === 1 &&
      parsed.algorithm === ALGORITHM &&
      typeof parsed.ciphertext === 'string' &&
      typeof parsed.iv === 'string' &&
      typeof parsed.salt === 'string' &&
      typeof parsed.tag === 'string'
    );
  } catch {
    return false;
  }
}

/** Returns true if encryption is configured and active. */
export function isEncryptionConfigured(): boolean {
  return hasEncryptionKey();
}
