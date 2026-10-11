/**
 * Smoke test for the guarantees this product actually sells.
 *
 * Run after `npm run db:seed`:
 *   npx tsx scripts/smoke.ts
 *
 * These are the claims worth proving: that nothing sends without approval,
 * that delivery is what gets billed, and that the state machine refuses
 * shortcuts. Each one is asserted, not just exercised.
 */
import { and, eq, like } from "drizzle-orm";
import { getDb } from "../src/db/client";
import {
  aiUsage,
  authSessions,
  businessFacts,
  messages,
  products,
  tasks,
  tenants,
  usageLedger,
  users,
} from "../src/db/schema";
import { sendTask, handleInboundMessage } from "../src/domain/pipeline";
import {
  approveTask,
  getTask,
  listApprovalQueue,
  listTaskEvents,
  recordUsage,
  rejectTask,
  summariseUsage,
  transitionTask,
} from "../src/domain/task-service";
import { IncoherentRateCardError, InvalidTransitionError, DEFAULT_RATE_CARD, assertRateCardCoherent, requiresApprovalFor } from "../src/domain/tasks";
import { importCsv, parseDate } from "../src/domain/import";
import { runDailySummaries } from "../src/domain/scheduler";
import { parseCsv } from "../src/lib/csv";
import { verifyPassword, verifyPasswordWithFallback } from "../src/lib/auth/password";
import { purgeExpiredSessions } from "../src/lib/auth/maintenance";
import { DEMO_PASSWORD } from "../src/lib/auth/demo";
import { answerCustomerQuestion, dayKey, tokensUsedToday } from "../src/ai/answer";
import { evaluateGrounding } from "../src/ai/ground";
import { runTool, type ToolFact } from "../src/ai/tools";
import { hallucinatingPriceProvider, ScriptedProvider } from "../src/ai/scripted";
import {
  claimHandoff,
  listHandoffs,
  openHandoff,
  resolveHandoff,
} from "../src/domain/handoffs";
import {
  createFact,
  deleteFact,
  setFactStatus,
  updateFact,
} from "../src/domain/knowledge";

let passed = 0;
let failed = 0;

/** The seeded owner's WhatsApp wa_id. */
const OWNER_WA_ID = "2348010000001";
/** A customer of the seeded shop. */
const CUSTOMER_WA_ID = "2348020000002";

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function main() {
  const db = await getDb();
  const [tenant] = await db.select().from(tenants).limit(1);
  if (!tenant) throw new Error("No tenant. Run `npm run db:seed` first.");

  // A real approver: tasks.approved_by is a foreign key to users.
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.tenantId, tenant.id))
    .limit(1);
  if (!owner) throw new Error("No owner user found. Run `npm run db:seed`.");
  const ownerId = owner.id;

  console.log(`\nAfriAgent smoke test -- ${tenant.name}\n`);

  /* -- 1. Fan-out: one message becomes several billable tasks ---------- */
  // The test drives its own inbound message so it is self-contained and
  // repeatable, rather than depending on whatever a previous run left behind.
  const outcome = await handleInboundMessage({
    waId: OWNER_WA_ID,
    body: "Show me today's sales, remind customers with overdue invoices, and tell me which products are running low",
    messageId: `wamid.SMOKE.${crypto.randomUUID()}`,
    timestamp: new Date(),
  });

  check(
    "sender is resolved as the business owner",
    outcome.role === "owner",
    `got ${outcome.role}`,
  );
  check(
    "one message fanned out into three tasks",
    outcome.taskIds.length === 3,
    `got ${outcome.taskIds.length}: ${outcome.taskIds.length} from the brief's example`,
  );

  // The tighter phrasing a shop owner would actually type, with no trailing
  // "and tell me which products" clause to lean on.
  const terse = await handleInboundMessage({
    waId: OWNER_WA_ID,
    body: "today's sales, overdue invoices, what's running low",
    messageId: `wamid.SMOKE.${crypto.randomUUID()}`,
    timestamp: new Date(),
  });
  check(
    "terse phrasing still fans out into three tasks",
    terse.taskIds.length === 3,
    `got ${terse.taskIds.length}`,
  );

  // A bare "and" is internal to a clause, not a separator.
  const internal = await handleInboundMessage({
    waId: OWNER_WA_ID,
    body: "do we have bread and milk in stock",
    messageId: `wamid.SMOKE.${crypto.randomUUID()}`,
    timestamp: new Date(),
  });
  check(
    "'bread and milk' stays one task, not two",
    internal.taskIds.length === 1,
    `got ${internal.taskIds.length}`,
  );

  const queue = await listApprovalQueue(tenant.id);
  check(
    "the two consequential tasks are queued for approval",
    queue.length >= 2,
    `approval queue has ${queue.length}`,
  );
  check(
    "every awaiting-approval task is gated",
    queue.every((t) => t.requiresApproval),
  );

  const invoiceTask = queue.find((t) => t.kind === "invoice_reminder");
  check("invoice reminder is in the queue", Boolean(invoiceTask));

  if (invoiceTask) {
    /* -- 2. Illegal transitions are refused --------------------------- */
    let threw = false;
    try {
      // pending_approval -> sent skips the gate entirely.
      await transitionTask(invoiceTask.id, "sent");
    } catch (e) {
      threw = e instanceof InvalidTransitionError;
    }
    check("cannot jump pending_approval -> sent", threw);

    /* -- 3. Approve, then deliver ------------------------------------- */
    const before = await summariseUsage(tenant.id);

    await approveTask(invoiceTask.id, ownerId);
    const mid = await getTask(invoiceTask.id);
    check("approve moves to `approved`", mid?.status === "approved");
    check(
      "approval is not billed until delivery",
      (await summariseUsage(tenant.id)).units === before.units,
    );

    await sendTask(invoiceTask.id, { dryRun: true });
    const after = await getTask(invoiceTask.id);
    check("delivery moves to `sent`", after?.status === "sent");
    check("sent task records a send time", Boolean(after?.sentAt));

    /* -- 3b. A batch task sends a TEMPLATE to each customer ------------ */
    // This is the assertion that was missing. `recipients` used to be returned
    // at the top level of the executor result, which the pipeline never
    // persisted -- so batch tasks silently degraded into one free-form message
    // to the owner. The task still reached `sent`, so nothing noticed.
    const delivery = (after?.result as { delivery?: { recipients?: unknown[] } }).delivery;
    check(
      "invoice reminder persisted a delivery plan",
      Array.isArray(delivery?.recipients) && delivery!.recipients!.length > 0,
      `recipients: ${delivery?.recipients?.length ?? 0}`,
    );

    // Scoped to this task via the dedupe key, otherwise template sends left
    // by earlier runs are counted too.
    const chased = (
      await db
        .select({ templateName: messages.templateName })
        .from(messages)
        .where(like(messages.dedupeKey, `${invoiceTask.id}:%`))
    ).filter((m) => m.templateName === "invoice_reminder").length;

    check(
      "each chased customer got an invoice_reminder template",
      chased === (delivery?.recipients?.length ?? 0) && chased > 0,
      `${chased} template sends for ${delivery?.recipients?.length ?? 0} recipients`,
    );

    const post = await summariseUsage(tenant.id);
    check(
      "delivery is what gets billed",
      post.units > before.units,
      `${before.units} -> ${post.units}`,
    );
    check(
      "usage increase matches the task's billable units",
      post.units - before.units === invoiceTask.billableUnits,
      `expected ${invoiceTask.billableUnits}`,
    );

    /* -- 4. `sent` is terminal, and metering is idempotent ------------- */
    let terminal = false;
    try {
      // A delivered task must not be re-openable: that would let a retry
      // re-send reminders a customer has already received.
      await transitionTask(invoiceTask.id, "approved");
    } catch (e) {
      terminal = e instanceof InvalidTransitionError;
    }
    check("`sent` is terminal — a delivered task cannot be re-opened", terminal);

    const ledgerRows = async () => {
      const rows = await db
        .select({ id: usageLedger.id })
        .from(usageLedger)
        .where(eq(usageLedger.taskId, invoiceTask.id));
      return rows.length;
    };

    const beforeRows = await ledgerRows();
    const delivered = (await getTask(invoiceTask.id))!;
    await recordUsage(delivered); // simulate duplicate delivery attempts
    await recordUsage(delivered);
    check(
      "metering the same task repeatedly still bills once",
      (await ledgerRows()) === beforeRows,
      `${beforeRows} ledger rows`,
    );
  }

  /* -- 5. The audit trail records every transition -------------------- */
  const anyTask = (await listApprovalQueue(tenant.id))[0] ?? invoiceTask;
  if (anyTask) {
    const events = await listTaskEvents(anyTask.id);
    check("task has an audit trail", events.length > 0, `${events.length} events`);
    check(
      "every event names a status",
      events.every((e) => Boolean(e.toStatus)),
    );
  }

  /* -- 6. Rejection terminates without sending ------------------------ */
  const lowStock = (await listApprovalQueue(tenant.id)).find(
    (t) => t.kind === "low_stock",
  );
  if (lowStock) {
    await rejectTask(lowStock.id, ownerId, "not now");
    const rejected = await getTask(lowStock.id);
    check("reject cancels the task", rejected?.status === "cancelled");
    check("rejection reason is recorded", rejected?.rejectionReason === "not now");
  }

  /* -- 7. Approval policy is the default, not a caller choice ---------- */
  check("invoice reminders always require approval", requiresApprovalFor("invoice_reminder"));
  check("sales reports do not require approval", !requiresApprovalFor("sales_report"));

  /* -- 8. The rate card is internally coherent ------------------------ */
  // This is the bug that shipped in the first pass: a ₦15,000 plan over 200
  // units implies ₦75/unit, but overage was priced at ₦0.50. Both halves are
  // now asserted so the two can never drift apart again.
  assertRateCardCoherent({
    planMonthlyMinor: DEFAULT_RATE_CARD.planMonthlyMinor,
    includedUnits: DEFAULT_RATE_CARD.includedUnits,
    overageRateMinor: DEFAULT_RATE_CARD.overageRateMinor,
  });
  check("default rate card is coherent", true);

  check(
    "bundled unit price equals the overage rate",
    DEFAULT_RATE_CARD.planMonthlyMinor / DEFAULT_RATE_CARD.includedUnits ===
      DEFAULT_RATE_CARD.overageRateMinor,
  );

  let incoherent = false;
  try {
    assertRateCardCoherent({
      planMonthlyMinor: 1_500_000,
      includedUnits: 200,
      overageRateMinor: 50, // the original bug
    });
  } catch (e) {
    incoherent = e instanceof IncoherentRateCardError;
  }
  check("an incoherent rate card is rejected", incoherent);

  /* -- 9. Billing distinguishes value from amount owed ---------------- */
  const summary = await summariseUsage(tenant.id);
  check(
    "amount due is subscription + overage",
    summary.totalDueMinor ===
      summary.planMinor + summary.overageUnits * DEFAULT_RATE_CARD.overageRateMinor,
    `${summary.totalDueMinor} vs ${summary.planMinor}+${summary.overageMinor}`,
  );
  check(
    "overage is zero while inside the allowance",
    summary.overageUnits === 0 || summary.units > summary.includedUnits,
    `${summary.units} units used, ${summary.includedUnits} included`,
  );
  check(
    "value delivered is tracked separately from what is owed",
    summary.valueDeliveredMinor > 0 && summary.valueDeliveredMinor !== summary.totalDueMinor,
  );

  /* -- 10. CSV import is safe and idempotent --------------------------- */
  // Unique per run so the suite is re-runnable against a database that
  // already has a previous run's rows in it.
  const runTag = crypto.randomUUID().slice(0, 8);

  const messy = [
    "sku,name,unit,stock,reorder_level,unit_price",
    `SMK1-${runTag},"Bread, sliced and seeded",loaf,4,8,650`, // comma inside quotes
    `SMK2-${runTag},Milk powder,tin,3,12,4200`,
    "",
  ].join("\r\n"); // CRLF, like Excel on Windows

  const parsed = parseCsv(messy);
  check("CSV parser keeps quoted commas intact", parsed[1]?.[1] === "Bread, sliced and seeded");
  check("CSV parser handles CRLF", parsed.length === 3, `${parsed.length} rows`);

  const bom = "\uFEFFsku,name\r\nSMK3-MILK.csv-test,Thing\r\n";
  check("CSV parser strips the Excel BOM", parseCsv(bom)[1]?.[0] === "SMK3-MILK.csv-test");

  // Day-first: African shops write 03/04 as 3 April, not 4 March.
  const dayFirst = parseDate("03/04/2026");
  check(
    "dates parse day-first, not US month-first",
    dayFirst?.getUTCMonth() === 3 && dayFirst?.getUTCDate() === 3,
    dayFirst?.toISOString(),
  );

  const dryRun = await importCsv(tenant.id, messy, "products", { dryRun: true });
  check(
    "import dry run previews the rows without writing",
    dryRun.dryRun === true && dryRun.created === 2,
    `dryRun=${dryRun.dryRun}, would create ${dryRun.created}`,
  );

  const commit1 = await importCsv(tenant.id, messy, "products", { dryRun: false });
  check("import creates rows", commit1.created === 2, `created ${commit1.created}`);

  const commit2 = await importCsv(tenant.id, messy, "products", { dryRun: false });
  check(
    "re-importing the same file updates rather than duplicates",
    commit2.created === 0 && commit2.updated === 2,
    `created ${commit2.created}, updated ${commit2.updated}`,
  );

  const broken = await importCsv(
    tenant.id,
    "sku,name,unit,stock,reorder_level,unit_price\n,No SKU,bag,1,1,100",
    "products",
    { dryRun: false },
  );
  check("a file with structural errors imports nothing", broken.errors.length > 0 && broken.created === 0);

  /* -- 11. The daily summary runs once, not twice --------------------- */
  // Clear any summary from an earlier run so "ran" is deterministic.
  await db.delete(tasks).where(eq(tasks.kind, "daily_summary"));

  const firstRun = await runDailySummaries();
  const summaryRun = firstRun.find((r) => r.tenantId === tenant.id);
  check("daily summary ran", summaryRun?.status === "ran", summaryRun?.reason);

  const secondRun = await runDailySummaries();
  const repeat = secondRun.find((r) => r.tenantId === tenant.id);
  check(
    "re-running the cron the same day is a no-op",
    repeat?.status === "skipped",
    `got ${repeat?.status}`,
  );

  /* -- 12. Cross-tenant isolation ------------------------------------- */
  // The simulator used to ignore the tenant supplied by the caller's session
  // and fall back to "first tenant in the table". With two registered
  // businesses that routes one shop's simulated message into another's data.
  // Runs last so the extra tenant cannot disturb the assertions above.
  const [other] = await db
    .insert(tenants)
    .values({ name: "Second Shop", slug: `second-${crypto.randomUUID().slice(0, 6)}`, country: "KE", currency: "KES", timezone: "Africa/Nairobi" })
    .returning();

  const otherOwnerWaId = "2348099999999";
  await db.insert(users).values({ tenantId: other.id, name: "Other Owner", phone: otherOwnerWaId, role: "owner" });

  const tasksBefore = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.tenantId, tenant.id))).length;

  const crossTenant = await handleInboundMessage({
    waId: otherOwnerWaId,
    body: "Show me today's sales",
    messageId: `wamid.SMOKE.${crypto.randomUUID()}`,
    timestamp: new Date(),
    tenantId: other.id,
  });

  check(
    "a message for tenant B resolves tenant B, not tenant A",
    crossTenant.tenantId === other.id,
    `resolved to ${crossTenant.tenantId.slice(0, 8)}`,
  );

  const leaked = await db.select().from(tasks).where(eq(tasks.tenantId, tenant.id));
  check(
    "no task leaks into the other tenant",
    leaked.length === tasksBefore,
    `${tasksBefore} -> ${leaked.length}`,
  );

  const landed = await db.select().from(tasks).where(eq(tasks.tenantId, other.id));
  check("the task landed in tenant B", landed.length > 0, `${landed.length} tasks`);

  await db.delete(tenants).where(eq(tenants.id, other.id)); // cascades

  /* -- 13. The documented quick start actually works ------------------ */
  // The dashboard resolves its tenant from a session, so a seeded demo shop
  // with no credentials is unreachable and its sample data is invisible.
  const [seededOwner] = await db
    .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.tenantId, tenant.id))
    .limit(1);
  const seededOwnerId = seededOwner!.id;

  check(
    "the seeded owner has credentials to sign in with",
    Boolean(seededOwner?.email && seededOwner?.passwordHash),
  );
  check(
    "the documented demo password verifies",
    Boolean(
      seededOwner?.passwordHash &&
        (await verifyPassword(DEMO_PASSWORD, seededOwner.passwordHash)),
    ),
  );
  check(
    "a wrong password does not verify",
    Boolean(
      seededOwner?.passwordHash &&
        !(await verifyPassword("not-the-password", seededOwner.passwordHash)),
    ),
  );

  /* -- 14. Auth does not leak which addresses exist ------------------- */
  // The public error message was already identical for both cases, but the
  // unknown-address path returned without running PBKDF2 at all -- measurably
  // faster, which is an enumeration oracle.
  const before = process.hrtime.bigint();
  await verifyPasswordWithFallback("password-for-timing", null);
  const unknownMs = Number(process.hrtime.bigint() - before) / 1e6;

  const before2 = process.hrtime.bigint();
  await verifyPasswordWithFallback("password-for-timing", seededOwner!.passwordHash!);
  const knownMs = Number(process.hrtime.bigint() - before2) / 1e6;

  check(
    "an unknown address still pays the PBKDF2 cost",
    unknownMs > 50,
    `unknown took ${unknownMs.toFixed(0)}ms, known took ${knownMs.toFixed(0)}ms`,
  );
  check(
    "unknown and known addresses take comparable time",
    Math.abs(unknownMs - knownMs) / Math.max(unknownMs, knownMs) < 0.75,
    `${unknownMs.toFixed(0)}ms vs ${knownMs.toFixed(0)}ms`,
  );
  check(
    "a missing stored hash never authenticates",
    !(await verifyPasswordWithFallback("anything", null)) &&
      !(await verifyPasswordWithFallback("anything", undefined)),
  );

  /* -- 15. Noise is not billed --------------------------------------- */
  // "ok" and a thumbs-up must not consume the shop's allowance, or the first
  // thing a business notices is their plan draining on greetings.
  const noise = await handleInboundMessage({
    waId: CUSTOMER_WA_ID,
    body: "ok",
    messageId: `wamid.SMOKE.${crypto.randomUUID()}`,
    timestamp: new Date(),
    tenantId: tenant.id,
  });

  check(
    "a greeting creates a task but is not billable",
    noise.taskIds.length === 1 &&
      (await getTask(noise.taskIds[0]!))?.isBillable === false,
  );

  const usageBeforeNoise = (await summariseUsage(tenant.id)).units;
  // Approve first: the state machine correctly refuses
  // pending_approval -> sending, which is the gate working.
  await approveTask(noise.taskIds[0]!, seededOwnerId);
  await sendTask(noise.taskIds[0]!, { dryRun: true });
  const usageAfterNoise = (await summariseUsage(tenant.id)).units;
  check(
    "delivering a non-billable task adds nothing to the ledger",
    usageBeforeNoise === usageAfterNoise,
    `${usageBeforeNoise} -> ${usageAfterNoise}`,
  );

  const real = await handleInboundMessage({
    waId: CUSTOMER_WA_ID,
    body: "Do you have Peak milk powder in stock?",
    messageId: `wamid.SMOKE.${crypto.randomUUID()}`,
    timestamp: new Date(),
    tenantId: tenant.id,
  });
  check(
    "a real question is still billable",
    real.taskIds.length > 0 &&
      (await getTask(real.taskIds[0]!))?.isBillable === true,
  );

  const blank = await handleInboundMessage({
    waId: CUSTOMER_WA_ID,
    body: "   ",
    messageId: `wamid.SMOKE.${crypto.randomUUID()}`,
    timestamp: new Date(),
    tenantId: tenant.id,
  });
  check("a blank message creates no task at all", blank.taskIds.length === 0);

  /* -- 16. Expired sessions are swept -------------------------------- */
  const sessionsBefore = (
    await db.select({ id: authSessions.id }).from(authSessions)
  ).length;
  if (sessionsBefore === 0) {
    await db.insert(authSessions).values({
      userId: seededOwnerId,
      tokenHash: `expired-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() - 1000),
    });
  }
  const purged = await purgeExpiredSessions();
  const sessionsAfter = (
    await db.select({ id: authSessions.id }).from(authSessions)
  ).length;
  check(
    "expired sessions are purged",
    purged >= 1 && sessionsAfter === sessionsBefore,
    `${sessionsBefore} -> ${sessionsAfter}, purged ${purged}`,
  );

  /* -- 17. The grounding layer refuses to invent ---------------------- */
  // The product claim is "it never makes up a price". It is enforced in code
  // rather than by asking the model nicely, so it is testable with no key.
  const priceFact: ToolFact = {
    // No "fact:" prefix on the id: `[fact:...]` is the citation marker the
    // model writes, and what sits inside the brackets is the fact id itself.
    id: "price-1",
    topic: "price",
    tier: "authoritative",
    subject: "Rice 50kg bag",
    value: "48000.00 NGN",
  };

  check(
    "an answer citing an authoritative price fact is answerable",
    evaluateGrounding({
      draft: "The Rice 50kg bag is 48,000.00 NGN [fact:price-1].",
      question: "how much is rice?",
      returnedFacts: [priceFact],
    }).verdict === "answerable",
  );

  check(
    "an invented price is refused",
    evaluateGrounding({
      draft: "Yes, that is ₦2,000 for the item.",
      question: "how much is it?",
      returnedFacts: [],
    }).verdict === "escalate",
  );

  check(
    "an invented price is refused even when other facts were returned",
    evaluateGrounding({
      draft: "We are open 8am. The price is ₦500.",
      question: "are you open?",
      returnedFacts: [
        {
          id: "fact:hours-1",
          topic: "hours",
          tier: "authoritative",
          subject: "Opening hours",
          value: "7am - 9pm",
        },
      ],
    }).verdict === "escalate",
  );

  check(
    "citing a fact no tool returned is refused",
    evaluateGrounding({
      draft: "Our policy is generous [fact:made-up-id].",
      question: "what is your policy?",
      returnedFacts: [],
    }).verdict === "escalate",
  );

  check(
    "a policy answered from prose alone is refused",
    evaluateGrounding({
      draft: "Returns are fine usually.",
      question: "what is your returns policy?",
      returnedFacts: [
        {
          id: "fact:faq-1",
          topic: "faq",
          tier: "informational",
          subject: "About us",
          value: "we are friendly",
        },
      ],
    }).verdict === "escalate",
  );

  check(
    "an ungrounded answer with no citations is refused",
    evaluateGrounding({
      draft: "Sure, no problem!",
      question: "hi",
      returnedFacts: [],
    }).verdict === "escalate",
  );

  check(
    "a provider failure escalates rather than answering",
    evaluateGrounding({
      draft: "",
      question: "anything",
      returnedFacts: [],
      failureReason: "provider unavailable",
    }).verdict === "escalate",
  );

  check(
    "the model can hand over to a human",
    evaluateGrounding({
      draft: "Let me check.",
      question: "q",
      returnedFacts: [],
      escalateToolReason: "customer asked for a manager",
    }).verdict === "escalate",
  );

  /* -- 18. Tools cannot cross tenants ---------------------------------- */
  // tenantId is injected from the verified session, never from arguments.
  const ownStock = await runTool("check_stock", { tenantId: tenant.id }, { query: "Rice" });
  check(
    "a tool reads the caller's own tenant",
    ownStock.ok && (ownStock.result.facts?.length ?? 0) > 0,
  );

  const smuggled = await runTool(
    "check_stock",
    { tenantId: tenant.id },
    { query: "Rice", tenantId: "00000000-0000-0000-0000-000000000000" },
  );
  check(
    "a tenantId smuggled into tool arguments is ignored",
    smuggled.ok &&
      JSON.stringify(smuggled.result.facts ?? []) ===
        JSON.stringify(ownStock.ok ? ownStock.result.facts : null),
  );

  check(
    "an unknown tool name is a readable error, not a crash",
    !(await runTool("drop_all_tables", { tenantId: tenant.id }, {})).ok,
  );

  check(
    "malformed tool arguments are rejected before any query",
    !(await runTool("look_up_price", { tenantId: tenant.id }, { query: 12345 })).ok,
  );

  /* -- 19. Draft facts are invisible to the model ---------------------- */
  const draftLookup = await runTool(
    "look_up_price",
    { tenantId: tenant.id },
    { query: "Wholesale" },
  );
  check(
    "an unpublished (draft) fact is never returned to the model",
    draftLookup.ok && (draftLookup.result.facts?.length ?? 0) === 0,
  );

  /* -- 20. Provider failure degrades, never crashes ------------------- */
  const outage = await answerCustomerQuestion(
    { tenantId: tenant.id, question: "how much is rice?" },
    new ScriptedProvider([
      { error: { message: "upstream 503", kind: "unavailable" } },
    ]),
  );
  check("a provider outage escalates instead of throwing", outage.verdict === "escalate");
  check("the failure reason is recorded", outage.reason.includes("upstream 503"));

  /* -- 21. A hallucinating provider is caught end to end -------------- */
  const hallucinated = await answerCustomerQuestion(
    { tenantId: tenant.id, question: "how much is the special pack?" },
    hallucinatingPriceProvider("₦2,000"),
  );
  check(
    "a confident, wrong price never reaches the customer",
    hallucinated.verdict === "escalate" && hallucinated.draft === "",
    `verdict=${hallucinated.verdict}`,
  );

  /* -- 22. A grounded answer is delivered ----------------------------- */
  const [rice] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.sku, "RICE-50"))
    .limit(1);

  const grounded = await answerCustomerQuestion(
    { tenantId: tenant.id, question: "how much is rice?" },
    new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "look_up_price", arguments: { query: "Rice" } }] },
      {
        content: `The Rice 50kg bag is 48,000.00 NGN per bag [fact:product:${rice!.id}].`,
      },
    ]),
  );
  check(
    "an answer backed by a tool fact is deliverable",
    grounded.verdict === "answerable" && grounded.draft.length > 0,
    `verdict=${grounded.verdict}, reason=${grounded.reason}`,
  );
  check(
    "tool use and token cost are recorded for calibration",
    grounded.toolsUsed.includes("look_up_price") && grounded.totalTokens > 0,
  );

  /* -- 23. Budget stops the spending before it happens ---------------- */
  await db.insert(aiUsage).values({
    tenantId: tenant.id,
    provider: "nvidia",
    model: "test",
    totalTokens: 999_999,
    costMicros: 1,
    day: dayKey(),
    outcome: "ok",
  });

  const exhausted = await answerCustomerQuestion({
    tenantId: tenant.id,
    question: "how much is rice?",
  });
  check(
    "an exhausted budget blocks the provider call entirely",
    exhausted.verdict === "escalate" && exhausted.totalTokens === 0,
    exhausted.reason,
  );
  check("budget exhaustion is reported, not silent", exhausted.reason.includes("budget"));

  await db
    .delete(aiUsage)
    .where(and(eq(aiUsage.tenantId, tenant.id), eq(aiUsage.totalTokens, 999_999)));

  /* -- 24. Escalations actually reach a human ------------------------- */
  // Telling a customer "someone will be with you" is only honest if a human
  // sees it queued. Before handoffs existed the agent gave up politely and
  // nobody was ever told.
  const handoffSource = await handleInboundMessage({
    waId: CUSTOMER_WA_ID,
    body: "Can I speak to a person about my wholesale pricing please?",
    messageId: `wamid.SMOKE.${crypto.randomUUID()}`,
    timestamp: new Date(),
    tenantId: tenant.id,
  });
  const handoffTaskId = handoffSource.taskIds[0];
  check("a customer question produced a task", Boolean(handoffTaskId));

  const handoffQueue = await listHandoffs(tenant.id);
  check(
    "the escalation landed in the human queue",
    handoffQueue.some((h) => h.taskId === handoffTaskId),
    `${handoffQueue.length} in the queue`,
  );

  const queued = handoffQueue.find((h) => h.taskId === handoffTaskId)!;
  check(
    "the handoff records why the assistant stopped",
    typeof queued.reason === "string" && queued.reason.length > 0,
    queued.reason,
  );
  check(
    "the handoff records what the customer actually asked",
    typeof (queued.context as Record<string, unknown>).asked === "string",
    JSON.stringify(queued.context).slice(0, 120),
  );
  check(
    "the queue shows who is waiting on it",
    Boolean(queued.contactWaId),
    queued.contactWaId ?? "none",
  );

  await openHandoff({
    tenantId: tenant.id,
    taskId: handoffTaskId,
    reason: "duplicate attempt",
  });
  check(
    "a retried task does not queue the customer twice",
    (await listHandoffs(tenant.id)).filter((h) => h.taskId === handoffTaskId)
      .length === 1,
  );

  // Claim is atomic: two staff, one winner.
  check(
    "a handover can be claimed",
    (await claimHandoff(queued.id, seededOwnerId, tenant.id)).ok,
  );
  const secondClaim = await claimHandoff(queued.id, seededOwnerId, tenant.id);
  check("the same handover cannot be claimed twice", !secondClaim.ok, secondClaim.error);
  check(
    "a handover cannot be claimed from another tenant",
    !(await claimHandoff(
      queued.id,
      seededOwnerId,
      "00000000-0000-0000-0000-000000000000",
    )).ok,
  );

  check(
    "a resolved handover leaves the open queue",
    (await resolveHandoff(queued.id, tenant.id, "handled at the counter")).ok &&
      !(await listHandoffs(tenant.id)).some((h) => h.id === queued.id),
  );
  check(
    "a closed handover cannot be closed again",
    !(await resolveHandoff(queued.id, tenant.id, "again")).ok,
  );

  /* -- 25. Knowledge is what makes the assistant useful --------------- */
  const facts = await db
    .select({
      tier: businessFacts.tier,
      status: businessFacts.status,
    })
    .from(businessFacts)
    .where(eq(businessFacts.tenantId, tenant.id));

  check("the demo shop has authoritative facts", facts.some((f) => f.tier === "authoritative"));
  check("the demo shop has informational facts", facts.some((f) => f.tier === "informational"));
  check(
    "an unpublished fact exists to prove it stays invisible",
    facts.some((f) => f.status === "draft"),
  );

  const hours = await runTool("check_opening_hours", { tenantId: tenant.id }, {});
  check(
    "the assistant can retrieve published hours",
    hours.ok && (hours.result.facts ?? []).some((f) => f.tier === "authoritative"),
  );

  const policy = await runTool("get_policy", { tenantId: tenant.id }, { topic: "policy" });
  check(
    "the assistant can retrieve a published policy",
    policy.ok && (policy.result.facts ?? []).length > 0,
  );

  // A knowledge base that answers nothing would escalate every question.
  const answerable = evaluateGrounding({
    draft: `We are open Monday to Saturday, 7am to 9pm [fact:${hours.ok ? hours.result.facts![0]!.id : "x"}].`,
    question: "what are your opening hours?",
    returnedFacts: hours.ok ? hours.result.facts! : [],
  });
  check(
    "a published fact lets the assistant answer instead of escalating",
    answerable.verdict === "answerable",
    answerable.verdict,
  );

  /* -- 26. One shop's knowledge is never another's -------------------- */
  const [rival] = await db
    .insert(tenants)
    .values({
      name: "Rival Shop",
      slug: `rival-${crypto.randomUUID().slice(0, 6)}`,
      country: "KE",
      currency: "KES",
      timezone: "Africa/Nairobi",
    })
    .returning();

  const rivalFacts = await db
    .select({ id: businessFacts.id })
    .from(businessFacts)
    .where(eq(businessFacts.tenantId, rival!.id));
  const rivalHours = await runTool("check_opening_hours", { tenantId: rival!.id }, {});

  check(
    "a second business with no facts gets no facts",
    rivalHours.ok && (rivalHours.result.facts ?? []).length === 0,
  );
  check("and none of the first business's facts leak into it", rivalFacts.length === 0);

  await db.delete(tenants).where(eq(tenants.id, rival!.id));

  /* -- 27. Knowledge writes are tenant-scoped ------------------------- */
  // The scoping used to live only inside the server action, where nothing
  // could test it. It is now a domain function, and the rule is checkable.
  const authored = await createFact(tenant.id, {
    subject: "Delivery cutoff",
    value: "Same-day orders must be placed before 4pm.",
    topic: "delivery",
    tier: "authoritative",
  });
  check("an owner can author a fact", authored.ok);

  const [authoredRow] = await db
    .select({ status: businessFacts.status })
    .from(businessFacts)
    .where(eq(businessFacts.id, (authored as { id: string }).id));
  check(
    "a new fact starts as a draft, never published",
    authoredRow?.status === "draft",
    authoredRow?.status,
  );

  const [rivalWrite] = await db
    .insert(tenants)
    .values({
      name: "Rival Two",
      slug: `rival2-${crypto.randomUUID().slice(0, 6)}`,
      country: "GH",
      currency: "GHS",
      timezone: "Africa/Accra",
    })
    .returning();

  const stolen = await updateFact(
    rivalWrite!.id,
    (authored as { id: string }).id,
    { subject: "Hijacked", value: "We charge whatever we like", topic: "price", tier: "authoritative" },
  );
  check(
    "one business cannot edit another business's fact",
    !stolen.ok,
    (stolen as { error?: string }).error,
  );

  const stolenDelete = await deleteFact(
    rivalWrite!.id,
    (authored as { id: string }).id,
  );
  check("nor delete it", !stolenDelete.ok);

  const stolenPublish = await setFactStatus(
    rivalWrite!.id,
    (authored as { id: string }).id,
    "active",
  );
  check("nor publish it", !stolenPublish.ok);

  const [stillDraft] = await db
    .select({ status: businessFacts.status })
    .from(businessFacts)
    .where(eq(businessFacts.id, (authored as { id: string }).id));
  check("and it is still a draft afterwards", stillDraft?.status === "draft");

  check(
    "an invalid fact is rejected with a readable reason",
    !(await createFact(tenant.id, { subject: "", value: "", topic: "price", tier: "authoritative" }))
      .ok,
  );
  check(
    "an unknown topic is rejected",
    !(await createFact(tenant.id, {
      subject: "Something",
      value: "Something",
      topic: "nonsense" as never,
      tier: "authoritative",
    })).ok,
  );

  // Publishing must actually change what the assistant can see.
  const beforePublish = await runTool("get_policy", { tenantId: tenant.id }, { topic: "delivery" });
  check(
    "a published fact is invisible while it is still a draft",
    !(beforePublish.ok ? beforePublish.result.facts ?? [] : []).some((f) =>
      f.subject === "Delivery cutoff",
    ),
  );

  await setFactStatus(tenant.id, (authored as { id: string }).id, "active");
  const afterPublish = await runTool("get_policy", { tenantId: tenant.id }, { topic: "delivery" });
  check(
    "and becomes visible the moment it is published",
    (afterPublish.ok ? afterPublish.result.facts ?? [] : []).some(
      (f) => f.subject === "Delivery cutoff",
    ),
  );

  await deleteFact(tenant.id, (authored as { id: string }).id);
  await db.delete(tenants).where(eq(tenants.id, rivalWrite!.id));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nSmoke test crashed:", err);
  process.exit(1);
});
