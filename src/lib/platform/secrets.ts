import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption for platform secrets.
 *
 * The NVIDIA API key is a credential that spends money and reaches a paid API.
 * Storing it as a plaintext column would put it in every database backup, every
 * `SELECT *`, and every accidental log line. It is encrypted at rest instead.
 *
 * AES-256-GCM, because it is authenticated: a tampered ciphertext fails to
 * decrypt rather than returning garbage that would then be sent to NVIDIA as a
 * key.
 *
 * The encryption key itself must live in the environment. This is a deliberate
 * bootstrap boundary -- a key that encrypts keys cannot be stored alongside the
 * things it protects, because reading it would be the same act as reading them.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export class PlatformSecretKeyMissingError extends Error {
  constructor() {
    super(
      "PLATFORM_SECRETS_KEY is not set. Platform secrets cannot be encrypted " +
        "or decrypted. Generate one with:\n" +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
    this.name = "PlatformSecretKeyMissingError";
  }
}

function key(): Buffer {
  const raw = process.env.PLATFORM_SECRETS_KEY;
  if (!raw) throw new PlatformSecretKeyMissingError();

  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32) {
    throw new Error(
      `PLATFORM_SECRETS_KEY must decode to exactly 32 bytes, got ${decoded.length}.`,
    );
  }
  return decoded;
}

/**
 * `v1.<iv>.<authTag>.<ciphertext>`, all base64url.
 *
 * Versioned so the scheme can be rotated later without having to guess which
 * rows were written under which one.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export class SecretDecryptionError extends Error {
  constructor(reason: string) {
    // Deliberately terse. This message can reach a log someone else reads, and
    // "token was tampered with" beats a stack trace full of ciphertext.
    super(`Could not decrypt platform secret: ${reason}`);
    this.name = "SecretDecryptionError";
  }
}

export function decryptSecret(stored: string): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new SecretDecryptionError("malformed payload");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof PlatformSecretKeyMissingError) throw error;
    // A wrong key and a tampered ciphertext are indistinguishable, which is the
    // point of an authenticated cipher rather than a gap in it.
    throw new SecretDecryptionError("authentication failed");
  }
}

/**
 * Enough of a secret to recognise it, never enough to use it.
 *
 * The last four characters are what an admin needs to tell "did my new key
 * save?" from "am I still on the old one?". They are not a meaningful share of
 * a key -- but this is also why the UI shows nothing else.
 */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return "*".repeat(8);
  return `${"*".repeat(Math.max(4, plaintext.length - 4))}${plaintext.slice(-4)}`;
}