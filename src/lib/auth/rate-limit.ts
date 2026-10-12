import { createHash } from "node:crypto";
import { and, count, eq, gte, lt } from "drizzle-orm";
import { getDb } from "@/db/client";
import { loginAttempts } from "@/db/schema";

/**
 * Login throttling.
 *
 * Two independent counters, because one alone is trivially defeated:
 *
 *   - per email, which survives an attacker rotating IP addresses
 *   - per IP,    which survives an attacker rotating email addresses
 *
 * Either one tripping blocks the attempt, so a distributed attack against one
 * account still hits the per-email wall, and a spray across many accounts from
 * one host still hits the per-IP wall.
 *
 * Identifiers are hashed. A throttling table that stores raw addresses is a
 * list of everyone who has been probed against the system.
 */

const WINDOW_MINUTES = 15;
const MAX_PER_EMAIL = 5;
const MAX_PER_IP = 20;

/** Overridable so tests can trip the limiter without waiting. */
export const THRESHOLDS = {
  windowMinutes: WINDOW_MINUTES,
  perEmail: MAX_PER_EMAIL,
  perIp: MAX_PER_IP,
};

function hash(value: string): string {
  // Normalised so "Bob@x.com" and "bob@x.com " are one identity.
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export interface ThrottleDecision {
  blocked: boolean;
  /** Which limit tripped, for the log. Never shown to the user verbatim. */
  reason?: "email" | "ip";
  retryAfterSeconds?: number;
}

async function recentFailures(identifier: string, since: Date): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ n: count() })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.identifier, identifier),
        eq(loginAttempts.succeeded, false),
        gte(loginAttempts.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

function windowStart(now: Date): Date {
  return new Date(now.getTime() - THRESHOLDS.windowMinutes * 60_000);
}

/**
 * Checks whether a login may proceed.
 *
 * Called before any credential work, so a blocked attempt costs a single
 * indexed count rather than 310k PBKDF2 iterations — the limiter must be
 * cheaper than the thing it protects.
 */
export async function checkLoginThrottle(args: {
  email: string;
  ip?: string | null;
  now?: Date;
}): Promise<ThrottleDecision> {
  const now = args.now ?? new Date();
  const since = windowStart(now);

  const emailFailures = await recentFailures(`email:${hash(args.email)}`, since);
  if (emailFailures >= THRESHOLDS.perEmail) {
    return {
      blocked: true,
      reason: "email",
      retryAfterSeconds: retryAfter(since, now),
    };
  }

  if (args.ip) {
    const ipFailures = await recentFailures(`ip:${hash(args.ip)}`, since);
    if (ipFailures >= THRESHOLDS.perIp) {
      return {
        blocked: true,
        reason: "ip",
        retryAfterSeconds: retryAfter(since, now),
      };
    }
  }

  return { blocked: false };
}

/** Records the outcome. Call on every attempt, successful or not. */
export async function recordLoginAttempt(args: {
  email: string;
  ip?: string | null;
  succeeded: boolean;
  now?: Date;
}): Promise<void> {
  const db = await getDb();
  const now = args.now ?? new Date();

  const rows = [
    {
      identifier: `email:${hash(args.email)}`,
      succeeded: args.succeeded,
      createdAt: now,
    },
  ];
  if (args.ip) {
    rows.push({
      identifier: `ip:${hash(args.ip)}`,
      succeeded: args.succeeded,
      createdAt: now,
    });
  }

  await db.insert(loginAttempts).values(rows);
}

/**
 * Clears the counters for an identity after a successful login.
 *
 * Without this a user who fumbles their password a few times and then signs
 * in correctly stays one mistake away from a lockout, which reads as the
 * product being broken rather than the attacker being slowed.
 */
export async function clearLoginAttempts(args: {
  email: string;
  ip?: string | null;
}): Promise<void> {
  const db = await getDb();
  const identifiers = [`email:${hash(args.email)}`];
  if (args.ip) identifiers.push(`ip:${hash(args.ip)}`);

  for (const identifier of identifiers) {
    await db.delete(loginAttempts).where(eq(loginAttempts.identifier, identifier));
  }
}

function retryAfter(since: Date, now: Date): number {
  const elapsed = now.getTime() - since.getTime();
  const total = THRESHOLDS.windowMinutes * 60_000;
  return Math.max(60, Math.ceil((total - elapsed) / 1000));
}

/** Drops attempts older than the window. Called from the daily cron. */
export async function purgeLoginAttempts(
  olderThan: Date = new Date(Date.now() - 24 * 60 * 60 * 1000),
): Promise<number> {
  const db = await getDb();
  const deleted = await db
    .delete(loginAttempts)
    .where(lt(loginAttempts.createdAt, olderThan))
    .returning({ id: loginAttempts.id });
  return deleted.length;
}
