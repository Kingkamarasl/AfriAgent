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

  // PGlite is a WASM build of Postgres and must not be bundled; postgres.js
  // expects a real Node socket. Both stay external to the server build.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
};

export default nextConfig;
