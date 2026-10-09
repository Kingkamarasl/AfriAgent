"use server";

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { createSession, destroyCurrentSession, getCurrentActor } from "@/lib/auth/session";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

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
  await createSession(newUserId);
  revalidatePath("/");
  redirect("/");
}

export async function loginAction(_previous: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = normaliseEmail(formData.get("email"));
  const password = String(formData.get("password") ?? "");
  if (!emailPattern.test(email) || !password || password.length > 128) return { error: "Enter your email and password." };
  const db = await getDb();
  const [user] = await db.select({ id: users.id, passwordHash: users.passwordHash }).from(users).where(eq(users.email, email)).limit(1);
  // Keep the public error identical for unknown users and wrong passwords.
  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) return { error: "Email or password is incorrect." };
  await createSession(user.id);
  revalidatePath("/");
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  if (await getCurrentActor()) await destroyCurrentSession();
  revalidatePath("/");
  redirect("/login");
}
