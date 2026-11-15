import {
  decrypt,
  encrypt,
  isEncrypted,
  isEncryptionConfigured,
} from './credential-encryption.js';

/**
 * CredentialService handles encryption/decryption of MCP server credentials
 * (env vars and headers) at rest, and redaction for REST API responses.
 *
 * When MCP_ENCRYPTION_KEY is not configured, credentials are stored in
 * plaintext with a warning. This preserves backward compatibility for
 * existing installations that have not set up encryption.
 *
 * Encrypted values use AES-256-GCM with a per-value salt and IV.
 * The encryption key must be a base64-encoded 32-byte value provided via
 * the MCP_ENCRYPTION_KEY environment variable.
 */
export class CredentialService {
  /**
   * Encrypt a JSON-serializable credentials object for storage.
   * Returns the encrypted string, or null if encryption is not configured
   * (in which case the caller should store the plaintext JSON).
   */
  encryptCredentials(obj: Record<string, string>): string | null {
    const json = JSON.stringify(obj);
    return encrypt(json);
  }

  /**
   * Decrypt an encrypted credentials string back to a record.
   * Returns undefined if decryption fails or encryption is not configured
   * (in which case the caller should treat the input as plaintext JSON).
   */
  decryptCredentials(encrypted: string): Record<string, string> | undefined {
    const decrypted = decrypt(encrypted);
    if (decrypted === null) return undefined;
    try {
      return JSON.parse(decrypted) as Record<string, string>;
    } catch {
      return undefined;
    }
  }

  /**
   * Check whether a stored string value is in the encrypted envelope format.
   */
  isValueEncrypted(value: string): boolean {
    return isEncrypted(value);
  }

  /**
   * Check whether encryption is configured and active.
   */
  isEncryptionActive(): boolean {
    return isEncryptionConfigured();
  }

  /**
   * Redact credential values in an env/headers record for REST API responses.
   * Replaces each value with '[REDACTED]' but preserves the keys so callers
   * know which fields are configured without exposing the secrets.
   */
  redactCredentials(creds: Record<string, string>): Record<string, string> {
    const redacted: Record<string, string> = {};
    for (const key of Object.keys(creds)) {
      redacted[key] = '[REDACTED]';
    }
    return redacted;
  }
}

/** Singleton instance used by the MCP routes and repositories. */
export const credentialService = new CredentialService();
