import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { getDb } from "@/db/client";
import { authTokens, users, type AuthTokenPurpose } from "@/db/schema";

/**
 * Email verification and password-recovery tokens.
 *
 * Same discipline as sessions: the raw token exists only in the emailed link,
 * and only its SHA-256 hash is stored. A database leak therefore yields no
 * working reset links.
 *
 * Issuing a new token invalidates any outstanding one for the same purpose, so
 * a forwarded old link stops working the moment a fresh one is sent.
 */

const VALID_HOURS: Record<AuthTokenPurpose, number> = {
  verify_email: 48,
  // Recovery is deliberately short: the window in which a reset link is live
  // is the window in which a mailbox compromise is useful.
  password_reset: 1,
};

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export async function createAuthToken(
  userId: string,
  purpose: AuthTokenPurpose,
): Promise<string> {
  const db = await getDb();

  // Invalidate outstanding tokens for this purpose before issuing a new one.
  await db
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(authTokens.userId, userId),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.consumedAt),
      ),
    );

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + VALID_HOURS[purpose] * 3_600_000);

  await db.insert(authTokens).values({
    userId,
    purpose,
    tokenHash: hashToken(token),
    expiresAt,
  });

  return token;
}

export type TokenFailure =
  | "invalid"
  | "expired"
  | "already_used";

export interface TokenCheck {
  userId: string;
  email: string | null;
}

/**
 * Validates a token without consuming it.
 *
 * Kept separate from `consumeAuthToken` so a caller can look before it leaps —
 * the reset form needs to know whether to render, and consuming on render
 * would burn the token before the user types their new password.
 */
export async function checkAuthToken(
  token: string,
  purpose: AuthTokenPurpose,
): Promise<
  | { ok: true; value: TokenCheck }
  | { ok: false; reason: TokenFailure }
> {
  const db = await getDb();

  const [row] = await db
    .select({
      userId: authTokens.userId,
      consumedAt: authTokens.consumedAt,
      expiresAt: authTokens.expiresAt,
      email: users.email,
    })
    .from(authTokens)
    .innerJoin(users, eq(authTokens.userId, users.id))
    .where(
      and(
        eq(authTokens.tokenHash, hashToken(token)),
        eq(authTokens.purpose, purpose),
      ),
    )
    .limit(1);

  if (!row) return { ok: false, reason: "invalid" };
  // Distinguishes "you already used this" from "this never existed", which
  // matters more to the user than it might seem.
  if (row.consumedAt) return { ok: false, reason: "already_used" };
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, value: { userId: row.userId, email: row.email } };
}

/** Marks a token used. Returns false if someone else consumed it first. */
export async function consumeAuthToken(
  token: string,
  purpose: AuthTokenPurpose,
): Promise<boolean> {
  const db = await getDb();
  const consumed = await db
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(authTokens.tokenHash, hashToken(token)),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, new Date()),
      ),
    )
    .returning({ id: authTokens.id });

  return consumed.length > 0;
}

/**
 * Marks the address verified.
 *
 * The `isNull` guard means a second use of an already-verified account's link
 * cannot re-stamp the timestamp, which would otherwise reset a
 * "verified a year ago" reading to "verified just now".
 */
export async function markEmailVerified(userId: string): Promise<boolean> {
  const db = await getDb();
  const updated = await db
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)))
    .returning({ id: users.id });

  return updated.length > 0;
}

export async function isEmailVerified(userId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ at: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return Boolean(row?.at);
}

/** Housekeeping. Consumed and long-expired tokens have no further use. */
export async function purgeAuthTokens(
  olderThan: Date = new Date(Date.now() - 7 * 24 * 3_600_000),
): Promise<number> {
  const db = await getDb();
  const deleted = await db
    .delete(authTokens)
    .where(lt(authTokens.expiresAt, olderThan))
    .returning({ id: authTokens.id });
  return deleted.length;
}
