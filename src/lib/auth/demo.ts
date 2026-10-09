/**
 * Local demo credentials.
 *
 * These exist only so `npm run db:seed` produces a shop you can actually sign
 * into. Once the dashboard resolves its tenant from a session, a seeded demo
 * without credentials is unreachable and all its sample data is invisible.
 *
 * Kept in their own module because importing them from `seed.ts` would run
 * that script. Never present in a real deployment -- `db:seed` refuses to run
 * against a DATABASE_URL unless explicitly overridden.
 */
export const DEMO_EMAIL = "owner@ojota.local";
export const DEMO_PASSWORD = "afriagent-demo-2026";
