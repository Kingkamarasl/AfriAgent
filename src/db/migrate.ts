import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import { getDb, isLocalPglite } from "./client";

/**
 * Applies the generated SQL migrations to whichever driver is active.
 *
 * The migration history is plain PostgreSQL, so dev (PGlite) and production
 * (Neon/Supabase) advance through exactly the same statements.
 */
export async function migrate(): Promise<void> {
  const db = await getDb();
  if (isLocalPglite) {
    await migratePglite(db as never, { migrationsFolder: "./drizzle" });
  } else {
    await migratePostgres(db as never, { migrationsFolder: "./drizzle" });
  }
}
