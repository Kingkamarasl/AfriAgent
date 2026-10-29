import "server-only";
import { getCurrentActor, type AuthActor } from "@/lib/auth/session";
import { isPlatformAdminEmail, NotPlatformAdminError } from "./admin";

/**
 * Session-bound platform-admin access.
 *
 * Split from `admin.ts` because that module must stay importable from scripts:
 * `server-only` throws when resolved outside the Next server, which is what
 * keeps `lib/auth/maintenance.ts` out of the smoke test today. Same reason,
 * same fix.
 */

/**
 * The signed-in actor, if they administer the platform.
 *
 * Requires a real, server-side session. This is never a decision based on
 * anything the client sends.
 */
export async function requirePlatformAdmin(): Promise<AuthActor> {
  const actor = await getCurrentActor();
  if (!actor || !isPlatformAdminEmail(actor.email)) throw new NotPlatformAdminError();
  return actor;
}

/** True when the current session may see the admin surface at all. */
export async function currentIsPlatformAdmin(): Promise<boolean> {
  const actor = await getCurrentActor();
  return isPlatformAdminEmail(actor?.email);
}