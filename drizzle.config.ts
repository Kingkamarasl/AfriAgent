import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  // PGlite is a dev convenience; migrations are always generated as plain
  // PostgreSQL SQL so prod and dev share one migration history.
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/afriagent",
  },
  strict: true,
  verbose: true,
});
