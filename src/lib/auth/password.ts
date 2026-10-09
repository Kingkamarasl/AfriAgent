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
