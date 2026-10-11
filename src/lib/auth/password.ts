import { pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const pbkdf2Async = promisify(pbkdf2);
const ITERATIONS = 310_000;
const KEY_LENGTH = 64;
const DIGEST = "sha512";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await pbkdf2Async(password, salt, ITERATIONS, KEY_LENGTH, DIGEST)) as Buffer;
  return `pbkdf2-sha512$${ITERATIONS}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterationText, saltHex, hashHex] = stored.split("$");
  const iterations = Number(iterationText);
  if (scheme !== "pbkdf2-sha512" || !Number.isInteger(iterations) || iterations < 100_000 || iterations > 1_000_000 || !saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, "hex");
    const actual = (await pbkdf2Async(password, Buffer.from(saltHex, "hex"), iterations, expected.length, DIGEST)) as Buffer;
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * A syntactically valid hash that matches no password, at the same cost as a
 * real one. 16-byte salt and 64-byte digest, so `verifyPassword` does exactly
 * the same amount of PBKDF2 work against it as against a stored credential.
 */
const TIMING_EQUALISER = `pbkdf2-sha512$${ITERATIONS}$${"00".repeat(16)}$${"00".repeat(64)}`;

/**
 * Constant-time-ish credential check.
 *
 * `verifyPassword` alone leaks whether an address exists: for an unknown
 * email the caller returns immediately and skips ~310k PBKDF2 iterations, so
 * the response is measurably faster than a wrong password on a real account.
 * The public error message is already identical for both cases; this makes the
 * *timing* identical too.
 *
 * Always returns false when there is no stored hash -- there is nothing to
 * compare against, and burning the time is the entire point.
 */
export async function verifyPasswordWithFallback(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  const valid = await verifyPassword(password, stored ?? TIMING_EQUALISER);
  return stored ? valid : false;
}
