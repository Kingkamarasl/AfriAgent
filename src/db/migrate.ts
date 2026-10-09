import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { getDb, isLocalPglite } from "./client";

/**
 * Applies the generated SQL migrations.
 *
 * Must be run from plain Node (`npm run db:migrate`), not from inside the Next
 * server. Drizzle's file-based migrator reads the migration directory with
 * `node:fs`, and once Turbopack bundles that module a `URL` instance reaches
 * the polyfill, which rejects it with:
 *
 *   The "path" argument must be of type string or an instance of Buffer or URL
 *
 * So the app does NOT migrate itself -- it warns and points here instead.
 */
export async function migrate(): Promise<void> {
  const db = await getDb();
  const folder = { migrationsFolder: path.resolve(process.cwd(), "drizzle") };

  if (isLocalPglite) {
    await migratePglite(db, folder);
  } else {
    // `db` is typed as the PGlite handle (see the `Database` type in
    // client.ts -- the union is collapsed deliberately). The two migrators
    // are the same function over the same query builder, so this cast is
    // correct at the branch that selects the driver.
    await migratePostgres(
      db as unknown as Parameters<typeof migratePostgres>[0],
      folder,
    );
  }
}
