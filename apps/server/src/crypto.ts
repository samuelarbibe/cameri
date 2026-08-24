import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

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
 * A signed, expiring capability — currently only "you may write this blob".
 *
 * Separate from `Cipher` because nothing here needs to be reversible: the
 * server hands out a URL and later has to recognise its own signature on it.
 */
export interface Signer {
  /** Returns the expiry and signature to hang off a URL. */
  sign(payload: string, ttlMs: number): { exp: number; sig: string };
  verify(payload: string, exp: string | undefined, sig: string | undefined): boolean;
}

/**
 * Derives the signing key rather than using the master directly.
 *
 * The same bytes should not both encrypt GitLab tokens and sign URLs: one key,
 * one job, so that a weakness in how signatures are used can never be turned
 * into anything that touches a stored credential.
 *
 * With no master key configured the signer falls back to random bytes, which is
 * correct for development and deliberately awkward beyond it — the URLs stop
 * verifying across a restart or a second replica, which is exactly the sort of
 * thing that gets noticed before it gets deployed.
 */
export function createSigner(master: Buffer | null, purpose: string): Signer {
  const key = master
    ? Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `cameri:${purpose}:v1`, KEY_BYTES))
    : randomBytes(KEY_BYTES);

  const mac = (payload: string, exp: number): string =>
    createHmac("sha256", key).update(`${payload}\n${exp}`).digest("base64url");

  return {
    sign(payload, ttlMs) {
      const exp = Math.floor((Date.now() + ttlMs) / 1000);
      return { exp, sig: mac(payload, exp) };
    },

    verify(payload, exp, sig) {
      if (!exp || !sig) return false;

      const deadline = Number(exp);
      if (!Number.isSafeInteger(deadline) || deadline * 1000 < Date.now()) return false;

      // Compare as bytes of equal length: `timingSafeEqual` throws on a length
      // mismatch, which would itself leak the length of the real signature.
      const expected = Buffer.from(mac(payload, deadline));
      const actual = Buffer.from(sig);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
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
