# AfriAgent

An AI employee for African businesses that works over WhatsApp, and asks before
it does anything consequential.

Businesses pay for **tasks completed**, not for access to a chatbot.

---

## The core idea

Most WhatsApp bots treat a conversation as the unit of work. AfriAgent treats a
**Task** as the unit of work.

A shop owner sends one message:

> "Show me today's sales, remind customers with overdue invoices, and tell me
> which products are running low."

That is **three Tasks**. Each one is independently:

- **auditable** — inputs, data read, output, who approved it
- **metered** — the thing you actually charge for
- **approvable** — nothing reaches a customer without sign-off

Because all three collapse into one table (`tasks` + `task_events` + `usage_ledger`),
the approval queue, the activity log and the billing page are all just different
views over the same rows.

```
inbound WhatsApp message
  -> resolve tenant + who sent it (owner or customer?)
  -> plan one or more Tasks
  -> execute each Task against tenant data
  -> approval gate  (auto-send only for low-risk kinds)
  -> deliver, meter, audit
```

## Quick start

```bash
npm install
npm run db:seed     # migrations + a demo Lagos shop with a week of trading
npm run dev         # http://localhost:3000
```

No database or Meta account needed — see [Zero-setup dev](#zero-setup-dev).

Then open the dashboard and either use the **WhatsApp simulator** on the left, or:

```bash
curl -X POST http://localhost:3000/api/simulate/inbound \
  -H "content-type: application/json" \
  -d '{"from":"2348010000001","text":"Show me today'\''s sales"}'
```

Run the guarantees end to end:

```bash
npm run smoke      # 20 assertions
```

## Zero-setup dev

| Concern | In development | In production |
| --- | --- | --- |
| Database | PGlite — real Postgres compiled to WASM, in-process, on disk at `.data/` | Postgres via `DATABASE_URL` (Neon, Supabase, self-hosted) |
| Migrations | Applied automatically on connect | Same, or `SKIP_AUTO_MIGRATE=1` |
| WhatsApp | Simulator — logs the exact payload it would have sent | Meta WhatsApp Cloud API |
| Auth | Seeded owner | Your session provider |

Both databases share one migration history, so the SQL you test against locally
is the SQL that runs in production. Setting `DATABASE_URL` is the only switch.

> **Windows note.** PGlite and `postgres` are loaded via a computed dynamic
> import rather than `serverExternalPackages`. Turbopack implements "external"
> on Windows by creating a symlink under `.next/dev/node_modules`, which this
> OS refuses without Administrator or Developer Mode, and the dev server dies
> with a Turbopack panic. See the comment in `src/db/client.ts`.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run smoke` | Asserts the product guarantees (see below) |
| `npm run db:seed` | Seed the demo shop (idempotent) |
| `npm run db:generate` | Generate migrations from the schema |
| `npm run db:studio` | Browse the database |

Migrations apply automatically on first connection, so `npm run dev` is always
in step with `src/db/schema.ts`. Set `SKIP_AUTO_MIGRATE=1` to manage them
yourself.

## Getting data in

The agent is only as good as what it can read, and shops have no API. CSV
import is the onboarding path, and it is deliberately two-step:

```
POST /api/import?kind=products            -> validate only, writes nothing
POST /api/import?kind=products&commit=1   -> write
```

Or use the panel on the dashboard. Sample files are in `samples/`.

Products accept `sku, name, unit, stock, reorder_level, unit_price`. Invoices
accept `number, customer_name, wa_id, amount, issued_on, due_on`.

Behaviour worth knowing:

- **Column aliases.** `price` / `cost` / `selling_price` all work. So do
  `phone`, `mobile`, `whatsapp`. Exports from different tools mostly just work.
- **Dates are day-first.** `31/12/2026` is 31 December, not 31 March. Reading
  it US-style silently produces due dates that are eight months wrong.
- **Phone numbers are normalised.** `+234 802 000 0002` matches a stored
  `2348020000002`, so you can re-import a corrected file without duplicating.
- **Re-importing is an upsert.** Matched on SKU / invoice number.
- **Structural errors block the whole import.** Nothing lands. Warnings (a
  missing price, an invoice with no WhatsApp number) do not block — those are
  the owner's judgement call. An invoice with no `wa_id` is still recorded, and
  the warning says it cannot be chased.

## Billing model

A subscription that bundles an allowance, plus metered overage:

```
plan (₦15,000)  ÷  included (200 tasks)  ==  overage rate (₦75/task)
```

That identity is asserted in code. It shipped broken once — a ₦15,000 plan
with a ₦0.50 overage rate meant heavy users never paid extra — so
`assertRateCardCoherent` now throws if the two halves drift apart, and the
smoke test covers it.

Two numbers that are deliberately kept apart:

- `valueDeliveredMinor` — what the agent did
- `totalDueMinor` — what the business owes

The dashboard shows **subscription / overage / due**, never a per-task price.
A shop owner who gets three approval cards from one WhatsApp message, each
priced separately, experiences it as nickel-and-diming rather than as three
pieces of work done.

## Scheduled work

```
GET /api/cron/daily-summary      Authorization: Bearer $CRON_SECRET
```

Runs the daily summary for every tenant that hasn't had one today (in *their*
timezone), and is safe to retry. The summary auto-sends: the recipient is the
shop's own owner, so there is no risk of committing the business to a customer,
and requiring a click every morning is exactly the approval fatigue that gets
the agent switched off. Anything customer-facing stays gated.

## What the smoke test proves

`npm run smoke` asserts the claims this product sells, rather than just
exercising code paths:

- one inbound message fans out into three separate billable tasks
- terse phrasing still fans out; `"bread and milk"` stays one task
- the sender is resolved as **owner vs customer** — the same words mean
  different things depending on who sent them
- `pending_approval -> sent` is **refused** (the gate cannot be skipped)
- approval alone does **not** bill; delivery does
- a batch task sends a **template per recipient** — and persists the plan
- `sent` is **terminal**, so a delivered task cannot be re-opened and re-sent
- metering the same task repeatedly bills once
- the rate card is coherent, and an incoherent one is rejected
- the CSV parser survives BOM, CRLF and quoted commas; dates are day-first
- an import with structural errors writes nothing
- the daily summary runs once, not twice
- every transition lands in the audit log

## Connecting real WhatsApp

Sign-up path, in order:

1. **Meta Business** — create a Business Portfolio and fill in Business Info.
   Verification needs a registration document and an official domain email.
2. **WhatsApp Manager** — create a **Test** number. You get a real WABA and
   token immediately, no verification. Start here.
3. **Production number** — requires business verification + display-name
   approval + a payment method for per-message fees. 3–7 days; start early.
4. **Public webhook** — Meta cannot reach `localhost`. Use `ngrok http 3000`.

Then set the variables in `.env.local` (see `.env.example`):

```
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_APP_SECRET=      # verifies X-Hub-Signature-256 — required in production
WHATSAPP_VERIFY_TOKEN=    # the token you choose when registering the webhook
```

Point Meta at `POST /api/webhooks/whatsapp` and subscribe to the `messages`
field.

### Two rules the code enforces for you

**1. The 24-hour customer service window.** Free-form replies are only legal
inside 24 hours of the customer last messaging you. Invoice reminders and daily
summaries go out on a schedule, so they are almost always *outside* it — which
means they must use pre-approved templates. This is modelled in
`conversations.windowExpiresAt` and enforced in `lib/whatsapp/client.ts`, which
throws rather than letting a send fail in production with Meta error `131009`.

**2. Per-message billing from Meta.** Meta now bills per message, not per
conversation. All cost logic is isolated so the rate card can be tuned without
touching the engine.

## Layout

```
src/
  db/
    schema.ts        all tables, enums, relations
    client.ts        PGlite / Postgres behind one interface
    migrate.ts       one migration history for both drivers
    seed.ts          demo shop with a week of trading
  domain/
    tasks.ts         THE STATE MACHINE + rate card
    task-service.ts  only place a task can change status
    pipeline.ts      inbound -> plan -> execute -> gate -> deliver
    intents.ts       message -> tasks (owner vs customer routing)
    execute.ts       sales / invoices / low stock / daily summary
    scheduler.ts     daily summary cron
    import.ts        CSV import with validation
  lib/
    whatsapp/        Cloud API client, templates, webhook parsing, HMAC verify
    csv.ts           RFC 4180 parser + column aliases
    money.ts         integer minor units only, never floats
    time.ts          tenant-timezone day boundaries
  app/
    api/webhooks/whatsapp    Meta webhook (verify + events)
    api/simulate/inbound     local simulator
    api/import               CSV import (dry run by default)
    api/cron/daily-summary   scheduled summaries
    page.tsx                 dashboard
```

### The state machine

`src/domain/tasks.ts` holds the legal transitions. Everything else is derived:

```
queued ──> running ──> draft_ready ──┬──> pending_approval ──> approved ──┐
                                     │                                     │
                                     └──> sending <───────────────────────┘
                                              │
                                              v
                                            sent
```

Anything not in that map is rejected in `transitionTask`, which also guards the
`UPDATE` with `status = <from>` so two concurrent workers cannot both drive the
same task forward and double-send a message to a customer.

## What is real vs. stubbed

**Real:** task engine and metering, approval gate, audit log, timezone-correct
reporting, WhatsApp Cloud API integration, webhook signature verification,
idempotent delivery, tenant scoping, PGlite/Postgres parity, CSV import with
validation, scheduled daily summary.

**Stubbed / not built yet:**

- **Auth.** `requireActor()` returns the seeded owner. Replace with a real
  session and verify role *and* tenant on every call — before shipping. This
  is still the biggest risk in the codebase.
- **Intent routing is regex, not an LLM.** Deliberately: every branch is
  testable and behaviour is identical with or without an API key. To swap in a
  model, replace the body of `routeMessage` with a tool-call loop returning the
  same `PlannedTask[]`. Nothing downstream changes.
- **No knowledge base.** `customer_question` and `appointment_book` have task
  kinds and states but no executor yet.
- **No durable queue.** Tasks execute inline in the webhook. Real deployments
  need Inngest or Trigger.dev so a slow report never delays Meta's ack.
- **Order import.** Products and invoices only; the CSV importer does not yet
  read historical sales, which is what `sales_report` reads from.
- **Rate card is a starting point.** Tune against real LLM + WhatsApp costs
  before quoting anyone.
- **No payments collection.** v1 chases invoices and sends a payment link; it
  does not take money. Mobile-money integration is deliberately out of scope.

## Suggested next steps

1. **Real auth + tenancy guards** — from last time; still the biggest risk.
2. **Decide the WhatsApp number question** — per-shop numbers or one shared
   number? It changes the schema, the onboarding flow and the compliance story.
3. **Order/sales import** — completes the data picture so the sales report
   works on day one rather than day thirty.
4. **Graduated autonomy** — auto-send low-risk categories, escalate on novelty
   or value thresholds, let the shop tune it.
5. **Durable queue** — move `processTask` into Inngest.
6. **Knowledge base** — document ingestion + retrieval for `customer_question`.

## Compliance notes

- Meta prohibits unofficial WhatsApp APIs. This uses the official Cloud API only.
- **POPIA** (ZA), **NDPA** (NG/KE) and friends: keep African customer PII in a
  in-region database (Neon AWS eu-west-1 / Supabase EU are common choices).
- Conversations contain customer PII. Retention and deletion policies are not
  built yet — do before real customers.

## Stack

Next.js 16 (App Router, Turbopack) · TypeScript · Tailwind v4 ·
Drizzle ORM · Postgres/PGlite · Meta WhatsApp Cloud API
