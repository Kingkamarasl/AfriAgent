import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/db/client";
import { authSessions, tenants, users } from "@/db/schema";

const COOKIE_NAME = "afriagent_session";
const SESSION_DAYS = 14;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export type AuthActor = { userId: string; tenantId: string; name: string; email: string; role: "owner" | "manager" | "staff"; tenantName: string; tenantSlug: string };

export async function createSession(userId: string): Promise<void> {
  const db = await getDb();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(authSessions).values({ userId, tokenHash: hashToken(token), expiresAt });
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function getCurrentActor(): Promise<AuthActor | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token || token.length > 200) return null;
  const db = await getDb();
  const [row] = await db.select({ userId: users.id, tenantId: users.tenantId, name: users.name, email: users.email, role: users.role, tenantName: tenants.name, tenantSlug: tenants.slug, sessionId: authSessions.id })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .innerJoin(tenants, eq(users.tenantId, tenants.id))
    .where(and(eq(authSessions.tokenHash, hashToken(token)), gt(authSessions.expiresAt, new Date())))
    .limit(1);
  if (!row || !row.email) return null;
  return { userId: row.userId, tenantId: row.tenantId, name: row.name, email: row.email, role: row.role, tenantName: row.tenantName, tenantSlug: row.tenantSlug };
}

export async function destroyCurrentSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (token && token.length <= 200) {
    const db = await getDb();
    await db.delete(authSessions).where(eq(authSessions.tokenHash, hashToken(token)));
  }
  cookieStore.set(COOKIE_NAME, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", expires: new Date(0) });
}
