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
| WhatsApp | Simulator — logs the exact payload it would have sent | Meta WhatsApp Cloud API |
| Auth | Seeded owner | Your session provider |

Both databases share one migration history, so the SQL you test against locally
is the SQL that runs in production. Setting `DATABASE_URL` is the only switch.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run smoke` | Asserts the product guarantees (see below) |
| `npm run db:seed` | Migrate + seed the demo shop (idempotent) |
| `npm run db:generate` | Generate migrations from the schema |
| `npm run db:studio` | Browse the database |

## What the smoke test proves

`npm run smoke` asserts the claims this product sells, rather than just
exercising code paths:

- one inbound message fans out into three separate billable tasks
- the sender is resolved as **owner vs customer** — the same words mean
  different things depending on who sent them
- `pending_approval -> sent` is **refused** (the gate cannot be skipped)
- approval alone does **not** bill; delivery does
- the usage increase exactly matches the task's billable units
- `sent` is **terminal**, so a delivered task cannot be re-opened and re-sent
- metering the same task repeatedly bills once
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
    tasks.ts         THE STATE MACHINE + metering policy
    task-service.ts  only place a task can change status
    pipeline.ts      inbound -> plan -> execute -> gate -> deliver
    intents.ts       message -> tasks (owner vs customer routing)
    execute.ts       sales / invoices / low stock / daily summary
  lib/
    whatsapp/        Cloud API client, templates, webhook parsing, HMAC verify
    money.ts         integer minor units only, never floats
    time.ts          tenant-timezone day boundaries
  app/
    api/webhooks/whatsapp    Meta webhook (verify + events)
    api/simulate/inbound     local simulator
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
idempotent delivery, tenant scoping, PGlite/Postgres parity.

**Stubbed / not built yet:**

- **Auth.** `requireActor()` returns the seeded owner. Replace with a real
  session and verify role *and* tenant on every call — before shipping.
- **Intent routing is regex, not an LLM.** Deliberately: every branch is
  testable and behaviour is identical with or without an API key. To swap in a
  model, replace the body of `routeMessage` with a tool-call loop returning the
  same `PlannedTask[]`. Nothing downstream changes.
- **No knowledge base.** `customer_question` and `appointment_book` have task
  kinds and states but no executor yet.
- **No durable queue.** Tasks execute inline in the webhook. Real deployments
  need Inngest or Trigger.dev so a slow report never delays Meta's ack.
- **Rate card is a placeholder** (`DEFAULT_PRICE_PER_UNIT_MINOR`). Tune against
  real LLM + WhatsApp costs before quoting anyone.
- **No payments collection.** v1 chases invoices and sends a payment link; it
  does not take money. Mobile-money integration is deliberately out of scope.

## Suggested next steps

1. **Real auth** — the only thing standing between this and anyone approving
   another business's messages.
2. **Durable queue** — move `processTask` into Inngest; the webhook must
   acknowledge in milliseconds.
3. **Knowledge base** — document ingestion + retrieval for `customer_question`.
   This is what makes the support flow genuinely useful rather than a lookup.
4. **Scheduled tasks** — `listScheduledReady` exists; wire it to a cron for the
   daily summary. This is the retention hook.
5. **Data import** — CSV/Excel upload. This is the real bottleneck for shops
   with no POS integration, and it gates how much the agent can honestly claim
   to know.

## Compliance notes

- Meta prohibits unofficial WhatsApp APIs. This uses the official Cloud API only.
- **POPIA** (ZA), **NDPA** (NG/KE) and friends: keep African customer PII in a
  in-region database (Neon AWS eu-west-1 / Supabase EU are common choices).
- Conversations contain customer PII. Retention and deletion policies are not
  built yet — do before real customers.

## Stack

Next.js 16 (App Router, Turbopack) · TypeScript · Tailwind v4 ·
Drizzle ORM · Postgres/PGlite · Meta WhatsApp Cloud API
