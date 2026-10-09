import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `cacheComponents` is deliberately off.
  //
  // Cache Components is for pages built from cached fetches. Every read in
  // AfriAgent is live, tenant-scoped data that must never be served stale --
  // an approval queue showing a task that was already sent is worse than a
  // slow page. Turning it on would add Suspense boundaries and a
  // partial-rendering model for zero benefit.
  cacheComponents: false,

  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },

  // PGlite is a WASM build of Postgres. It reads its own data directory via
  // `import.meta.url`, so it must be a real Node module at runtime -- once
  // Turbopack bundles it, that becomes a `URL` object where PGlite expects a
  // path and every query fails with ERR_INVALID_ARG_TYPE.
  //
  // `serverExternalPackages` is the supported way to keep it external. On
  // Windows Turbopack may implement that with a symlink, which needs
  // Administrator or Developer Mode; if junction creation fails, run dev with
  // `--webpack` (`npm run dev:webpack`), which externalises server
  // dependencies without touching the filesystem.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
};

export default nextConfig;
