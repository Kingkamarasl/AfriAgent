"use server";

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { createSession, destroyCurrentSession, getCurrentActor } from "@/lib/auth/session";
import { destroyAllSessions } from "@/lib/auth/maintenance";
import { hashPassword, verifyPasswordWithFallback } from "@/lib/auth/password";
import {
  checkLoginThrottle,
  clearLoginAttempts,
  recordLoginAttempt,
} from "@/lib/auth/rate-limit";
import { checkAuthToken, consumeAuthToken, createAuthToken } from "@/lib/auth/tokens";
import {
  passwordResetEmail,
  sendEmail,
  verificationEmail,
} from "@/lib/email";
import { requireActor } from "@/app/actions";

/**
 * Best-effort client address, for throttling.
 *
 * Behind a proxy the socket address is the proxy, so the forwarded header is
 * what actually identifies a caller. It is attacker-controlled, which is why
 * it is only ever one of two independent counters -- a forged header cannot
 * clear the per-email limit.
 */
async function clientIp(): Promise<string | null> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return h.get("x-real-ip");
}

export type AuthFormState = { error?: string };
const normaliseEmail = (value: FormDataEntryValue | null) => String(value ?? "").trim().toLowerCase();
const safeText = (value: FormDataEntryValue | null) => String(value ?? "").trim();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function registerAction(_previous: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const businessName = safeText(formData.get("businessName"));
  const name = safeText(formData.get("name"));
  const email = normaliseEmail(formData.get("email"));
  const password = String(formData.get("password") ?? "");
  const country = safeText(formData.get("country")).toUpperCase() || "LR";
  if (businessName.length < 2 || businessName.length > 100) return { error: "Enter a business name between 2 and 100 characters." };
  if (name.length < 2 || name.length > 100) return { error: "Enter your name." };
  if (!emailPattern.test(email) || email.length > 254) return { error: "Enter a valid email address." };
  if (password.length < 12 || password.length > 128) return { error: "Use a password with at least 12 characters." };
  const supportedCountries = new Set(["LR", "GH", "NG", "SL", "GM", "US", "GB", "KE", "ZA"]);
  if (!supportedCountries.has(country)) return { error: "Choose a supported country." };

  const db = await getDb();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) return { error: "An account with that email already exists. Try signing in." };

  const baseSlug = businessName.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "business";
  const slug = `${baseSlug}-${randomUUID().slice(0, 8)}`;
  const currencyByCountry: Record<string, string> = { LR: "LRD", GH: "GHS", NG: "NGN", SL: "SLE", GM: "GMD", US: "USD", GB: "GBP", KE: "KES", ZA: "ZAR" };
  const timezoneByCountry: Record<string, string> = { LR: "Africa/Monrovia", GH: "Africa/Accra", NG: "Africa/Lagos", SL: "Africa/Freetown", GM: "Africa/Banjul", US: "America/New_York", GB: "Europe/London", KE: "Africa/Nairobi", ZA: "Africa/Johannesburg" };
  let newUserId: string;
  try {
    const passwordHash = await hashPassword(password);
    const created = await db.transaction(async (tx) => {
      const [tenant] = await tx.insert(tenants).values({ name: businessName, slug, country, currency: currencyByCountry[country] ?? "USD", timezone: timezoneByCountry[country] ?? "UTC" }).returning({ id: tenants.id });
      const [user] = await tx.insert(users).values({ tenantId: tenant.id, name, email, passwordHash, role: "owner" }).returning({ id: users.id });
      return user.id;
    });
    newUserId = created;
  } catch (error) {
    // The unique database index handles simultaneous duplicate registrations.
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505") return { error: "An account with that email already exists. Try signing in." };
    console.error("Registration failed", error);
    return { error: "We couldn't create your account right now. Please try again." };
  }

  // Sign the new owner in immediately — a shop owner should not have to prove
  // they own a mailbox before seeing their own empty dashboard. Verification
  // gates password *reset*, which is the flow that actually matters.
  await createSession(newUserId);

  // Never let a mail failure break registration.
  await sendVerificationEmail(newUserId, businessName);

  revalidatePath("/");
  redirect("/");
}

export async function loginAction(_previous: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = normaliseEmail(formData.get("email"));
  const password = String(formData.get("password") ?? "");
  const ip = clientIp();
  if (!emailPattern.test(email) || !password || password.length > 128) return { error: "Enter your email and password." };

  // Checked before any credential work, so a throttled attempt costs one
  // indexed count rather than 310k PBKDF2 iterations.
  const throttle = await checkLoginThrottle({ email, ip: await clientIp() });
  if (throttle.blocked) {
    const minutes = Math.ceil((throttle.retryAfterSeconds ?? 60) / 60);
    return {
      error: `Too many attempts. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    };
  }

  const db = await getDb();
  const [user] = await db.select({ id: users.id, passwordHash: users.passwordHash }).from(users).where(eq(users.email, email)).limit(1);
  // Identical message AND identical timing for unknown-address and
  // wrong-password; see `verifyPasswordWithFallback`.
  const passwordOk = await verifyPasswordWithFallback(password, user?.passwordHash);
  const ok = Boolean(user && passwordOk);

  await recordLoginAttempt({ email, ip: await clientIp(), succeeded: ok });

  if (!ok) return { error: "Email or password is incorrect." };

  // A success clears the counters, so a few fumbled attempts followed by a
  // correct sign-in does not leave someone one typo from a lockout.
  await clearLoginAttempts({ email, ip: await clientIp() });
  await createSession(user!.id);
  revalidatePath("/");
  redirect("/");
}

/* ------------------------------------------------------------------ */
/* Email verification and password recovery                             */
/* ------------------------------------------------------------------ */

function appUrl(path: string): string {
  const base = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base.replace(/\/$/, "")}${path}`;
}

async function sendVerificationEmail(userId: string, businessName: string) {
  const db = await getDb();
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.email) return;

  const token = await createAuthToken(userId, "verify_email");
  await sendEmail({
    ...verificationEmail(businessName, appUrl(`/verify-email?token=${token}`)),
    to: user.email,
  });
}

export async function resendVerificationAction(): Promise<AuthFormState> {
  try {
    const actor = await requireActor();
    const db = await getDb();
    const [row] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        verifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.id, actor.userId))
      .limit(1);

    if (!row?.email) return { error: "No email address on this account." };
    if (row.verifiedAt) return { error: "This address is already verified." };

    await sendVerificationEmail(row.id, row.name);
    return { error: "" };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Could not send the email.",
    };
  }
}

/**
 * Starts a password reset.
 *
 * Always returns the same message. Saying "no account with that address"
 * would turn this form into an account-enumeration oracle.
 */
export async function forgotPasswordAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = normaliseEmail(formData.get("email"));
  if (!emailPattern.test(email)) {
    // Still the generic message: a malformed address is not proof of
    // existence either way.
    return { error: "" };
  }

  const db = await getDb();
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      verifiedAt: users.emailVerifiedAt,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (user?.email) {
    // Recovery requires a proven mailbox. Otherwise anyone could register
    // with someone else's address, then reset their way in.
    if (user.verifiedAt) {
      const token = await createAuthToken(user.id, "password_reset");
      await sendEmail({
        ...passwordResetEmail(appUrl(`/reset-password?token=${token}`)),
        to: user.email,
      });
    } else {
      // Unverified: do not send, but do not say so either.
      console.warn(
        `[auth] password reset requested for unverified account ${user.id}`,
      );
    }
  }

  return { error: "" };
}

export async function resetPasswordAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const token = String(formData.get("token") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!token) return { error: "This reset link is not valid." };
  if (password.length < 12 || password.length > 128) {
    return { error: "Use a password with at least 12 characters." };
  }
  if (password !== confirm) return { error: "The two passwords do not match." };

  const check = await checkAuthToken(token, "password_reset");
  if (!check.ok) {
    return {
      error:
        check.reason === "already_used"
          ? "This link has already been used. Request a new one."
          : check.reason === "expired"
            ? "This link has expired. Request a new one."
            : "This reset link is not valid.",
    };
  }

  // Consume before writing the password. If the write fails the link is spent,
  // which is the safe direction to fail: an attacker cannot retry.
  if (!(await consumeAuthToken(token, "password_reset"))) {
    return { error: "This link has already been used. Request a new one." };
  }

  const db = await getDb();
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(users.id, check.value.userId));

  // Every existing session dies. A stolen cookie must not outlive the
  // password it was issued against -- this is the single most important line
  // in the reset flow.
  await destroyAllSessions(check.value.userId);

  revalidatePath("/login");
  return { error: "" };
}

export async function logoutAction(): Promise<void> {
  if (await getCurrentActor()) await destroyCurrentSession();
  revalidatePath("/");
  redirect("/login");
}
