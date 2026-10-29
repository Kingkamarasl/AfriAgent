# AfriAgent — code audit

Audit date: 2026-10-09. **Superseded — see `README.md` for current status.**

Kept for provenance. Most of what follows has since been built; the entries below
are marked so this file is not mistaken for a live list of open blockers.

## What has been closed since this audit

| Finding | Status |
| --- | --- |
| Critical — auth lifecycle incomplete (verification, reset, throttling) | **Done.** All three implemented; 27 assertions cover the recovery flows. |
| Critical — tenant scoping must be systematic | **Done for the built surface.** Session-derived identity everywhere; a cross-tenant leak was found and fixed twice by verification rather than by tests. |
| High — AI engine and knowledge base not complete | **Done.** Provider seam, tool allowlist, two-tier knowledge base with retrieval, output validation, per-tenant budget, escalation on ungrounded answers. |
| High — webhook replay protection | **Done.** HMAC verification plus idempotency keyed on provider message ID. |
| High — billing is a foundation, not integrated | **Partly.** Rate card is coherent and metered per completed task. No payment provider yet. |
| Medium — production operations | **Partly.** Docs updated, `.env.example` complete, smoke suite at 188 assertions. No CI, no error monitoring, no backups. |

## Still open

1. **Order/sales import.** The importer writes products and invoices but not
   orders, while `sales_report` is computed from orders. The flagship report is
   therefore empty for any shop importing real data. Highest-value fix.
2. **Durable queue.** Tasks run inline in the webhook.
3. **Per-tenant WhatsApp credentials.** Required before a second shop exists.
4. **No CI.** Typecheck, lint, smoke and build are run by hand.
5. **No payment provider.** v1 chases invoices but does not take money.

## Not code

- Meta business verification (domain, domain email, incorporation documents).
- The WhatsApp numbering decision — blocked on BSP answers.