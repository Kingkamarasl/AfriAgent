import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

/**
 * Two drivers behind one interface.
 *
 *   DATABASE_URL set -> real Postgres (Neon / Supabase / self-hosted).
 *   DATABASE_URL unset -> PGlite, a real Postgres compiled to WASM that runs
 *   in-process and persists to `.data/`. Dev stays zero-setup while the
 *   dialect, the SQL and the migrations stay identical to production.
 */

export const isLocalPglite = !process.env.DATABASE_URL;

type Database = ReturnType<typeof buildPglite> | ReturnType<typeof buildPostgres>;

function buildPglite() {
  // Required lazily: importing WASM at module scope breaks the build graph.
  const { PGlite } = require("@electric-sql/pglite") as typeof import("@electric-sql/pglite");
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");

  const dataDir = process.env.PGLITE_PATH ?? ".data/pglite";
  // PGlite's own mkdir is non-recursive, so a missing parent (`.data`) throws
  // ENOENT rather than creating the chain.
  mkdirSync(dataDir, { recursive: true });

  const client = new PGlite(dataDir);
  return drizzlePglite(client, { schema });
}

function buildPostgres() {
  const postgres = require("postgres") as typeof import("postgres");
  const client = postgres(process.env.DATABASE_URL!, {
    max: 10,
    prepare: false, // Required by poolers (PgBouncer, Neon, Supabase).
  });
  return drizzlePostgres(client, { schema });
}

/**
 * Next dev re-evaluates modules on every HMR pass. Without a global handle
 * each pass would open a new PGlite lock on the same data directory and the
 * dev server would wedge, so the connection is pinned to globalThis.
 */
const globalForDb = globalThis as unknown as {
  __afriagentDb?: Database;
  __afriagentDbPromise?: Promise<Database>;
};

async function connect(): Promise<Database> {
  return isLocalPglite ? buildPglite() : buildPostgres();
}

export const dbPromise: Promise<Database> =
  globalForDb.__afriagentDbPromise ??
  (globalForDb.__afriagentDbPromise = connect().then((d) => {
    globalForDb.__afriagentDb = d;
    return d;
  }));

/** Await the handle, reusing the pinned connection across HMR passes. */
export async function getDb(): Promise<Database> {
  if (globalForDb.__afriagentDb) return globalForDb.__afriagentDb;
  return dbPromise;
}

export { schema };
