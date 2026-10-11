import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

/**
 * Two drivers behind one interface.
 *
 *   DATABASE_URL set -> real Postgres (Neon / Supabase / self-hosted).
 *   DATABASE_URL unset -> PGlite, a real Postgres compiled to WASM that runs
 *   in-process and persists to `.data/`. Dev stays zero-setup while the
 *   dialect, the SQL and the migrations stay identical to production.
 *
 * Migrations are applied once on connect. PGlite is single-writer, so seeding
 * the same directory while `next dev` holds it open leaves the dev server on a
 * stale schema. Auto-migrating on boot keeps the running app in step with
 * `src/db/schema.ts`, which is the thing that actually matters in dev.
 */

export const isLocalPglite = !process.env.DATABASE_URL;

/**
 * The driver packages are loaded through a *computed* specifier on purpose.
 *
 * Listing them in `serverExternalPackages` is the documented approach, but
 * Turbopack implements "external" on Windows by creating a symlink under
 * `.next/dev/node_modules`, and this OS refuses symlinks without
 * Administrator or Developer Mode ("Access is denied (os error 5)"), taking
 * the dev server down with a Turbopack panic. A specifier the bundler cannot
 * statically resolve is left alone and resolved by Node at runtime.
 */
async function buildPglite() {
  const specifier = "@electric-sql/pglite";
  const { mkdirSync } = await import("node:fs") as typeof import("node:fs");

  const dataDir = process.env.PGLITE_PATH ?? ".data/pglite";
  // PGlite's own mkdir is non-recursive, so a missing parent (`.data`) throws
  // ENOENT rather than creating the chain.
  mkdirSync(dataDir, { recursive: true });

  const { PGlite } = await import(specifier);
  return drizzlePglite(new PGlite(dataDir), { schema });
}

async function buildPostgres() {
  const specifier = "postgres";
  type PostgresFactory = (
    connectionString: string,
    options?: Record<string, unknown>,
  ) => ReturnType<typeof import("postgres")>;

  // postgres.js is CommonJS, so the callable lands on `.default`.
  const mod = (await import(specifier)) as unknown as { default: PostgresFactory };
  const client = mod.default(process.env.DATABASE_URL!, {
    max: 10,
    prepare: false, // Required by poolers (PgBouncer, Neon, Supabase).
  });
  // Cast is deliberate: see the `Database` type below.
  return drizzlePostgres(client, { schema }) as unknown as Database;
}

/**
 * A single type, not a union of the two drivers.
 *
 * Drizzle's query-builder API is identical across both, so modelling this as
 * `Pglite | PostgresJs` buys nothing and costs a great deal: TypeScript cannot
 * resolve a union of generic methods, so `db.transaction(...)` degrades `tx`
 * to a shape where `.returning({ id })` type-checks as a 0-arg call. The
 * union is collapsed once, here, at the boundary.
 */
export type Database = PgliteDatabase<typeof schema>;

async function connect(): Promise<Database> {
  return isLocalPglite ? buildPglite() : buildPostgres();
}

/**
 * Next dev re-evaluates modules on every HMR pass, and `next build` imports
 * this module in several workers. Without a global handle each pass would open
 * a new PGlite lock on the same data directory; with module-scope connection
 * even a plain import would instantiate the WASM engine and abort the build.
 *
 * So the connection is created on first use and pinned to globalThis.
 */
const globalForDb = globalThis as unknown as {
  __afriagentDb?: Database;
  __afriagentDbPromise?: Promise<Database>;
  __afriagentLivenessChecked?: boolean;
};

/**
 * Await the handle, creating the connection on first call.
 *
 * Also runs a one-time schema liveness check.
 *
 * Migrations deliberately do NOT run here: drizzle's file-based migrator reads
 * the migration directory through `node:fs`, and once Turbopack bundles that
 * module a URL instance reaches the polyfill and it throws
 * ERR_INVALID_ARG_TYPE. Apply them out of process instead -- `npm run
 * db:migrate`, or `npm run db:seed`.
 *
 * Probing means a missing schema is reported before the caller's own query
 * fails with a bewildering "column does not exist", and stays quiet during
 * `next build`, which imports modules but never queries.
 */
export async function getDb(): Promise<Database> {
  if (globalForDb.__afriagentDb) return globalForDb.__afriagentDb;

  globalForDb.__afriagentDbPromise ??= connect().then((d) => {
    globalForDb.__afriagentDb = d;
    return d;
  });
  const db = await globalForDb.__afriagentDbPromise;

  if (!globalForDb.__afriagentLivenessChecked) {
    globalForDb.__afriagentLivenessChecked = true;
    try {
      await db.select({ one: sql`1` }).from(schema.tenants).limit(1);
    } catch {
      console.warn(
        "\n[db] The schema is missing or out of date." +
          "\n[db] Run `npm run db:migrate` (or `npm run db:seed` to build the demo shop).\n",
      );
    }
  }

  return db;
}

export { schema };
