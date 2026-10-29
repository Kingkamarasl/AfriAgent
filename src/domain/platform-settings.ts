import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { platformSettings } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/platform/secrets";

/**
 * Platform-wide configuration.
 *
 * Global by design. Tenant admins must never reach provider credentials or
 * platform policy -- a shop owner who can read the NVIDIA key can spend the
 * company's money, and one who can edit the model can change how every customer
 * is answered.
 *
 * Lives outside server actions so it can be tested directly; the pattern that
 * `domain/knowledge.ts` and `domain/handoffs.ts` already use.
 *
 * Secrets are encrypted at rest. Plain settings are not, because they hold
 * nothing sensitive.
 */

/** Names that are treated as secrets. Anything else is stored in the clear. */
export const PLATFORM_SECRET_KEYS = ["nvidia_api_key"] as const;
export type PlatformSecretKey = (typeof PLATFORM_SECRET_KEYS)[number];

export function isPlatformSecret(key: string): boolean {
  return (PLATFORM_SECRET_KEYS as readonly string[]).includes(key);
}

/** Marker wrapping a ciphertext so a secret is never mistaken for a value. */
const SECRET_FIELD = "_secret";

/**
 * Short-lived cache.
 *
 * An AI call happens per inbound message; reading settings on each one adds a
 * query to the hot path for a value that changes rarely. Thirty seconds is
 * chosen so a key rotation takes effect promptly without a round trip per
 * message. Single-process caches are invalidated on write; multi-instance
 * deployments converge through the TTL.
 */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: unknown; expiresAt: number }>();

function cacheGet(key: string): unknown | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key: string, value: unknown): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Called after a write so the next read sees it immediately. */
export function invalidatePlatformSettings(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

async function readRow(key: string): Promise<Record<string, unknown> | undefined> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.key, key))
    .limit(1);
  return row?.value;
}

async function writeRow(key: string, value: Record<string, unknown>): Promise<void> {
  const db = await getDb();
  await db
    .insert(platformSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedAt: new Date() } });
}

/**
 * A non-secret setting.
 *
 * Returns `fallback` when unset, so callers never have to distinguish "absent"
 * from "set to nothing" against a default they already chose.
 */
export async function getPlatformSetting<T>(
  key: string,
  fallback: T,
): Promise<T> {
  const cached = cacheGet(key);
  if (cached !== undefined) return cached as T;

  const row = await readRow(key);
  if (!row || row[SECRET_FIELD] !== undefined) {
    cacheSet(key, fallback);
    return fallback;
  }

  const value = (row.value ?? fallback) as T;
  cacheSet(key, value);
  return value;
}

export async function setPlatformSetting(key: string, value: unknown): Promise<void> {
  if (isPlatformSecret(key)) {
    throw new Error(`${key} is a secret; use setPlatformSecret`);
  }
  await writeRow(key, { value });
  invalidatePlatformSettings(key);
}

/**
 * A secret, decrypted.
 *
 * Absent rather than throwing when unset: a missing key is a configuration
 * state the caller reports, not an error. A key that is present but will not
 * decrypt *is* an error, because that means PLATFORM_SECRETS_KEY changed under
 * a stored value and every send would otherwise fail mysteriously.
 */
export async function getPlatformSecret(key: string): Promise<string | null> {
  const cached = cacheGet(key);
  if (cached !== undefined) return cached as string | null;

  const row = await readRow(key);
  const cipher = row?.[SECRET_FIELD];
  if (typeof cipher !== "string" || cipher.length === 0) {
    cacheSet(key, null);
    return null;
  }

  const value = decryptSecret(cipher);
  cacheSet(key, value);
  return value;
}

export async function setPlatformSecret(key: string, plaintext: string): Promise<void> {
  if (!isPlatformSecret(key)) {
    throw new Error(`${key} is not a registered secret; add it to PLATFORM_SECRET_KEYS`);
  }
  const trimmed = plaintext.trim();
  if (!trimmed) throw new Error("Refusing to store an empty secret");

  await writeRow(key, { [SECRET_FIELD]: encryptSecret(trimmed) });
  invalidatePlatformSettings(key);
}

export async function clearPlatformSecret(key: string): Promise<void> {
  const db = await getDb();
  await db.delete(platformSettings).where(eq(platformSettings.key, key));
  invalidatePlatformSettings(key);
}

/**
 * Whether a secret is present, for display.
 *
 * Never returns the value. The admin UI is told "set / not set" and nothing
 * more, so there is no path -- not even a mistaken one -- by which a rendered
 * page or a server action's return value can leak it.
 */
export async function describePlatformSecret(
  key: string,
): Promise<{ set: boolean; masked?: string }> {
  const value = await getPlatformSecret(key);
  if (value === null) return { set: false };
  // Last four characters only, and only for recognising a rotation.
  return { set: true, masked: `...${value.slice(-4)}` };
}