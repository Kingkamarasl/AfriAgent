# Contributing to AfriAgent

Thanks for helping improve AfriAgent. Keep changes focused, preserve the tenant
and approval boundaries, and add or update a smoke assertion when changing a
product guarantee.

## Prerequisites

- Node.js 22 (the version used by CI)
- npm
- Git

Install the exact dependency versions recorded in the lockfile:

```bash
npm ci
```

Copy `.env.example` to `.env.local` only when you need to configure an external
service. The app can run locally without credentials, using PGlite, the WhatsApp
simulator, and the console email provider.

## Local development

For a disposable local demo database:

```bash
npm run db:seed
npm run dev
```

Open `http://localhost:3000` and sign in with the demo credentials printed by the
seed command. `db:seed` creates or resets demo tenant data; use it only with the
local PGlite database. It refuses to run when `DATABASE_URL` is set unless the
destructive override is explicitly supplied. Do not point the seed or smoke
suite at a production database.

The normal schema migration command is:

```bash
npm run db:migrate
```

Migrations run in a separate process by design. When changing the schema, update
the Drizzle schema and generate or write the corresponding migration; test it
through the same migration command used in CI.

## Validation

Run the checks before submitting a change:

```bash
npm run typecheck
npm run lint
npm run db:migrate
npm run db:seed
npm run smoke
npm run smoke
npm run build
```

The smoke suite exercises product and security guarantees against the seeded
local database. It is intentionally run twice in CI to catch tests that depend
on leftover state. It does not require an AI API key. `npm run ai:check` is
different: it calls the configured NVIDIA endpoint and should be used only when
you intentionally want to test live provider credentials and network access.

## Pull requests and CI

The workflow in `.github/workflows/ci.yml` runs on pull requests, pushes to
`main`, and manual dispatch. It uses Node.js 22 and executes the same typecheck,
lint, migration, seed, smoke (twice), and production-build checks listed above.
Keep secrets out of commits; configure local credentials in an ignored
`.env.local` file and use `.env.example` for documenting variable names and
purpose.

## Change guidelines

- Keep business rules in `src/domain/` or `src/lib/`, not only in a UI action, so
you can exercise them outside the page that invokes them.
- Derive tenant identity from the verified server-side session or trusted
  webhook resolution; never accept a tenant ID supplied by the model or browser
  as authorization.
- Preserve the explicit approval gate for consequential customer-facing
  actions, and keep transitions routed through the task service.
- Treat migrations, authentication, rate limits, provider calls, and customer
  data as security-sensitive. Include focused tests for changes to those
  boundaries.
- Update the README when setup steps, readiness claims, or user-facing
  capabilities change.
