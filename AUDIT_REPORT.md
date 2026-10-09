# AfriAgent — Initial Code Audit

Audit date: 2026-10-09

## Summary

This repository is a promising development prototype with a task-oriented workflow, approval gates, a usage ledger, CSV import tooling, a WhatsApp Cloud API integration path, and a dashboard. It is **not production-ready**. Authentication and tenant isolation are the main release blockers.

## Changes made in this audit copy

1. Replaced the undefined `LayoutProps<"/">` annotation with React's `ReactNode` type in `src/app/layout.tsx`.
2. Reworked the dashboard activity-window calculation to avoid `Date.now()` during render.
3. Changed WhatsApp webhook signature verification to fail closed in production when `WHATSAPP_APP_SECRET` is missing.
4. Added `/register` and `/login` flows, PBKDF2-SHA512 password hashing, opaque random session tokens stored as SHA-256 hashes, 14-day HttpOnly/SameSite cookies, and logout/session revocation.
5. Added database-backed session and password-hash schema migration. Registration creates a tenant and owner in one database transaction and normalises email addresses.
6. Dashboard and protected server actions now resolve tenant identity from the session. Owner/manager checks guard task approval/rejection/edit/retry and CSV imports.
7. The development simulator now requires authentication and derives tenant identity from the session rather than trusting a caller-supplied tenant slug. It remains disabled in production.
8. Updated README and `.env.example` to describe current capabilities and remaining launch blockers.

## Findings and release blockers

### Critical — account lifecycle and auth hardening remain incomplete

Basic email/password authentication and session validation are now implemented, but email verification, password reset/recovery, login rate limiting, MFA, suspicious-login controls, and team invitations/role management are still missing. The current implementation is a foundation for a private pilot, not sufficient on its own for a public launch.

### Critical — tenant scoping must be systematic

Every page, server action, API route, background job, and database mutation must derive tenant identity from a verified session or a verified provider-to-tenant mapping. Never trust a tenant ID supplied by a browser or webhook payload alone.

### High — webhook processing needs durable delivery semantics

The WhatsApp webhook handler performs processing in the request and catches individual message failures while acknowledging the overall request. Before launch, persist inbound events idempotently and enqueue processing, then acknowledge only after durable acceptance. Add replay protection/idempotency keyed by provider message ID.

### High — background work is not yet a durable queue

Scheduled summaries and task processing need a durable job mechanism, bounded retries, dead-letter visibility, concurrency control, and safe duplicate execution. A small PostgreSQL-backed queue may be appropriate for the first paid pilot if it avoids another service.

### High — AI engine and knowledge base are not complete

Intent routing is primarily rule/regex based. A production AI service needs a provider abstraction, business-scoped retrieval, tool allowlists, output validation, per-tenant usage limits, prompt-injection defenses, redaction and traceable outcomes.

### High — billing is a foundation, not an integrated subscription system

The usage ledger and rate-card checks are useful, but paid launch still needs a verified payment provider integration, signed webhook handling, subscription state transitions, invoice/receipt records, reconciliation and clear overage behavior.

### Medium — import hardening

Add maximum request size, row-count limits, duplicate-key validation within the same CSV, transactional commits, and tests for malicious or malformed files. Preserve dry-run-by-default behavior.

### Medium — production operations

Add health/readiness checks, structured redacted logs, error monitoring, backups with restore tests, migration release procedures, rate limiting, security headers, data-retention/deletion workflows, and a privacy policy.

## Verification status

- Source inspection completed for the application routes, actor resolver, WhatsApp signature verification, import flow, database client and smoke-test script.
- `npm ci --ignore-scripts --no-audit --no-fund` did not complete in the audit environment before timeout.
- `npm run typecheck` was attempted but failed before checking project source because the dependency installation is incomplete (missing Node, React, and other type definitions).
- Smoke tests, lint, and production build therefore remain **unverified**. Do not interpret this audit as a passing build.

## Recommended next sequence

1. Add email verification, password recovery, login throttling, and auth-flow tests.
2. Add route-level and service-level tests for cross-tenant access denial and role permissions.
3. Make webhook intake durable and idempotent.
4. Add durable background processing and retry controls.
5. Implement the model provider abstraction and grounded knowledge retrieval.
6. Complete subscription billing and usage reconciliation.
7. Run clean install, typecheck, lint, smoke tests, production build, and deployment checks in CI.
