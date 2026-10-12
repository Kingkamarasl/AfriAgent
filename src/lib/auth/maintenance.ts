import { eq, lt } from "drizzle-orm";
import { getDb } from "@/db/client";
import { authSessions } from "@/db/schema";

/**
 * Auth maintenance.
 *
 * Deliberately separate from `session.ts`: that module is `server-only` (it
 * reads and writes cookies, and cannot be imported outside the Next build),
 * while these are pure database operations that belong in scheduled jobs and
 * tests. Nothing here reads or returns a secret.
 */

/**
 * Kills every session for a user.
 *
 * Called after a password reset. A stolen cookie must not outlive the
 * password it was issued against -- otherwise "I reset my password because I
 * think someone else is in my account" changes nothing at all.
 */
export async function destroyAllSessions(userId: string): Promise<number> {
  const db = await getDb();
  const deleted = await db
    .delete(authSessions)
    .where(eq(authSessions.userId, userId))
    .returning({ id: authSessions.id });
  return deleted.length;
}

/**
 * Drops every expired session row.
 *
 * `createSession` only bounds accounts that keep signing in; this is the sweep
 * for everyone else. Called from the daily cron, which is the only recurring
 * job in the system.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const db = await getDb();
  const deleted = await db
    .delete(authSessions)
    .where(lt(authSessions.expiresAt, new Date()))
    .returning({ id: authSessions.id });
  return deleted.length;
}
