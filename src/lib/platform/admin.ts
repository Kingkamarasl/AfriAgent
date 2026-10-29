/**
 * Platform-admin authorisation.
 *
 * There is no platform role in the user model -- `owner | manager | staff` are
 * all tenant-scoped, and every one of them belongs to a shop. Adding a
 * platform-wide role to `users` would mean a tenant owner could be granted
 * reach over credentials that spend the company's money, which is exactly the
 * confusion the tenant/platform boundary exists to prevent.
 *
 * So the allowlist is configuration: `PLATFORM_ADMIN_EMAILS`. It is deliberately
 * an env var rather than a table, because who may administer the platform is a
 * deployment decision, not something a database compromise should be able to
 * rewrite. If the list is empty, nobody is a platform admin -- fail closed.
 *
 * Deliberately free of `server-only` and of any session import, so the rule
 * itself is testable from a script. `admin-session.ts` holds the part that needs
 * a verified session.
 */

export class NotPlatformAdminError extends Error {
  constructor() {
    super("You do not have access to platform settings.");
    this.name = "NotPlatformAdminError";
  }
}

function allowlist(): Set<string> {
  return new Set(
    (process.env.PLATFORM_ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isPlatformAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowlist().has(email.trim().toLowerCase());
}