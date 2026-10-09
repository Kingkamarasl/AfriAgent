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

  // NOTE: `serverExternalPackages` is deliberately NOT used for
  // @electric-sql/pglite or postgres. On Windows, Turbopack implements
  // "external" in dev by creating a junction inside .next/dev/node_modules,
  // which requires symlink privileges the OS does not grant by default --
  // the dev server then dies with "Access is denied (os error 5)".
  // `src/db/client.ts` loads both via a computed dynamic import instead,
  // which the bundler leaves alone and Node resolves at runtime.
};

export default nextConfig;
