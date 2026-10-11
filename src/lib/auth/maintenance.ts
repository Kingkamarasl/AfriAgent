import { lt } from "drizzle-orm";
import { getDb } from "@/db/client";
import { authSessions } from "@/db/schema";

/**
 * Auth maintenance.
 *
 * Deliberately separate from `session.ts`: that module is `server-only` (it
 * reads and writes cookies, and cannot be imported outside the Next build),
 * while this is pure database work that belongs in scheduled jobs and tests.
 *
 * Nothing here reads or returns a secret.
 */

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
