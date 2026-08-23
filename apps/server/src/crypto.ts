import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Symmetric encryption for outbound credentials.
 *
 * Record keys are *hashed* because the server only ever has to recognise one.
 * An integration token is different in kind: the server has to present it to
 * GitLab, so it must be recoverable, and the honest thing is to say so rather
 * than to pretend a reversible secret is as safe as a hash.
 *
 * AES-256-GCM, so a tampered ciphertext fails to decrypt instead of silently
 * yielding garbage that gets sent to a third party as a bearer token.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const KEY_BYTES = 32;
const VERSION = "v1";

export class MissingEncryptionKeyError extends Error {
  constructor() {
    super(
      "CAMERI_ENCRYPTION_KEY is not set. Generate one with " +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"` " +
        "and set it before configuring an integration.",
    );
    this.name = "MissingEncryptionKeyError";
  }
}

/**
 * Parses the configured key once, at startup, so a malformed value is a boot
 * failure rather than a surprise the first time someone opens settings.
 */
export function parseEncryptionKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `CAMERI_ENCRYPTION_KEY must be ${KEY_BYTES} bytes of base64, got ${key.length}`,
    );
  }
  return key;
}

export interface Cipher {
  encrypt: (plaintext: string) => string;
  decrypt: (payload: string) => string;
}

/**
 * Returns a cipher, or throws if no key is configured.
 *
 * Callers are expected to let that throw reach the user: "you have not set an
 * encryption key" is actionable, and silently storing a token in plaintext to
 * avoid an error message would be much worse.
 */
export function createCipher(key: Buffer | null): Cipher {
  if (!key) throw new MissingEncryptionKeyError();

  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      // Version prefix so a future key rotation or algorithm change can tell
      // old ciphertexts apart instead of failing to decrypt them mysteriously.
      return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(
        ".",
      );
    },

    decrypt(payload) {
      const [version, iv, tag, body] = payload.split(".");
      if (version !== VERSION || !iv || !tag || !body) {
        throw new Error("stored credential is not in a format this server understands");
      }
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(body, "base64")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

/**
 * The tail of a token, for recognition in the UI.
 *
 * Short enough to be useless to an attacker who has the database but not the
 * key, long enough for someone to tell two of their own tokens apart.
 */
export function tokenHint(token: string): string {
  return token.length <= 4 ? "…" : `…${token.slice(-4)}`;
}
