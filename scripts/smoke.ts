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
  authTokens,
  businessFacts,
  loginAttempts,
  messages,
  products,
  tasks,
  tenants,
  usageLedger,
  users,
  whatsappLinks,
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
import { currentTotals, importCsv, parseDate } from "../src/domain/import";
import { orders, orderItems } from "../src/db/schema";
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
import {
  checkLoginThrottle,
  clearLoginAttempts,
  purgeLoginAttempts,
  recordLoginAttempt,
  THRESHOLDS,
} from "../src/lib/auth/rate-limit";
import {
  checkAuthToken,
  consumeAuthToken,
  createAuthToken,
  isEmailVerified,
} from "../src/lib/auth/tokens";
import { destroyAllSessions } from "../src/lib/auth/maintenance";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret } from "../src/lib/platform/secrets";
import { isPlatformAdminEmail } from "../src/lib/platform/admin";
import {
  clearPlatformSecret,
  describePlatformSecret,
  getPlatformSecret,
  getPlatformSetting,
  invalidatePlatformSettings,
  setPlatformSecret,
  setPlatformSetting,
} from "../src/domain/platform-settings";
import { resolveProvider } from "../src/ai/index";
import { platformSettings } from "../src/db/schema";
import { getEmailProvider, passwordResetEmail, sendEmail, verificationEmail } from "../src/lib/email";
import {
  canSend,
  canTransitionLink,
  createLink,
  getLinkForPhoneNumber,
  recordNumberBound,
  setLinkStatus,
} from "../src/lib/whatsapp/links";

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

  /* -- 28. Login throttling ------------------------------------------ */
  // Credential stuffing is the likelier threat here, not privilege escalation.
  // Two independent counters, because either one alone is trivially routed
  // around.
  const probe = { email: "throttle-probe@ojota.local", ip: "203.0.113.9" };
  await clearLoginAttempts(probe);
  check("a fresh identity is not throttled", !(await checkLoginThrottle(probe)).blocked);

  for (let i = 0; i < THRESHOLDS.perEmail; i++) {
    await recordLoginAttempt({ ...probe, succeeded: false });
  }

  const throttled = await checkLoginThrottle(probe);
  check("repeated failures lock the identity out", throttled.blocked, `reason=${throttled.reason}`);
  check("the lockout says how long to wait", (throttled.retryAfterSeconds ?? 0) > 0);

  // Rotating IP must not help an attacker targeting the same account...
  const rotatedIp = await checkLoginThrottle({
    email: probe.email,
    ip: "198.51.100.4",
  });
  check("rotating IP does not defeat the per-email limit", rotatedIp.blocked, `reason=${rotatedIp.reason}`);

  // ...and a different account must not help them from the same host.
  const otherAccount = { email: "spray-target@ojota.local", ip: probe.ip };
  check("a different account on the same host is unaffected", !(await checkLoginThrottle(otherAccount)).blocked);

  for (let i = 0; i < THRESHOLDS.perIp; i++) {
    await recordLoginAttempt({ email: `spray-${i}@ojota.local`, ip: probe.ip, succeeded: false });
  }
  check(
    "spraying many accounts from one host trips the per-IP limit",
    (await checkLoginThrottle({ email: "brand-new@ojota.local", ip: probe.ip })).blocked,
  );

  await clearLoginAttempts(probe);
  check(
    "a successful sign-in clears the failure count",
    !(await checkLoginThrottle({ email: probe.email, ip: "203.0.113.9" })).blocked,
  );

  await db.delete(loginAttempts);
  for (let i = 0; i < 3; i++) {
    await recordLoginAttempt({ email: `purge-${i}@x.com`, ip: "198.51.100.77", succeeded: false });
  }
  check("expired attempts are swept by the cron", (await purgeLoginAttempts(new Date(Date.now() + 1000))) > 0);

  /* -- 29. Password recovery ----------------------------------------- */
  check("the seeded owner is verified", await isEmailVerified(seededOwnerId));

  const resetToken = await createAuthToken(seededOwnerId, "password_reset");
  check("a reset link validates before it is used", (await checkAuthToken(resetToken, "password_reset")).ok);

  const verifyToken = await createAuthToken(seededOwnerId, "verify_email");
  check(
    "a reset token cannot be used to verify an email",
    !(await checkAuthToken(resetToken, "verify_email")).ok,
  );
  check(
    "a verification token cannot reset a password",
    !(await checkAuthToken(verifyToken, "password_reset")).ok,
  );

  check("the token is consumable once", await consumeAuthToken(resetToken, "password_reset"));
  check("and not twice", !(await consumeAuthToken(resetToken, "password_reset")));

  const reused = await checkAuthToken(resetToken, "password_reset");
  check(
    "a used token says it was used, not that it is invalid",
    !reused.ok && (reused as { reason: string }).reason === "already_used",
  );

  check("a made-up token is rejected", !(await checkAuthToken("nope", "password_reset")).ok);

  // Expiry: expire every outstanding reset token for this user.
  const doomed = await createAuthToken(seededOwnerId, "password_reset");
  await db
    .update(authTokens)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(authTokens.userId, seededOwnerId));
  check(
    "an expired token is refused",
    !(await checkAuthToken(doomed, "password_reset")).ok,
  );
  check(
    "and cannot be consumed",
    !(await consumeAuthToken(doomed, "password_reset")),
  );

  // Issuing a new link invalidates the old one, so a forwarded link dies.
  const oldToken = await createAuthToken(seededOwnerId, "password_reset");
  await createAuthToken(seededOwnerId, "password_reset");
  const oldCheck = await checkAuthToken(oldToken, "password_reset");
  check(
    "issuing a new link invalidates the previous one",
    !oldCheck.ok && (oldCheck as { reason: string }).reason === "already_used",
  );

  /* -- 30. A reset kills every existing session ----------------------- */
  // The most important line in the reset flow: a stolen cookie must not
  // outlive the password it was issued against.
  await db.insert(authSessions).values([
    { userId: seededOwnerId, tokenHash: `sess-a-${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 86_400_000) },
    { userId: seededOwnerId, tokenHash: `sess-b-${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 86_400_000) },
  ]);

  const beforeReset = (
    await db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.userId, seededOwnerId))
  ).length;
  const killed = await destroyAllSessions(seededOwnerId);
  const afterReset = (
    await db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.userId, seededOwnerId))
  ).length;

  check("sessions exist before the reset", beforeReset >= 2, `${beforeReset}`);
  check(
    "a password reset kills every session",
    afterReset === 0 && killed === beforeReset,
    `${beforeReset} -> ${afterReset}`,
  );

await db.delete(authTokens);

  /* ---------------------------------------------------------------- */
  /* WhatsApp link lifecycle                                           */
  /* ---------------------------------------------------------------- */

  console.log("\nWhatsApp connection lifecycle");

  // The point of the lifecycle is that the numbering model stays a per-tenant
  // setting rather than a code fork, so both modes must be expressible.
  check("pending -> awaiting_review is legal", canTransitionLink("pending", "awaiting_review"));
  check(
    "pending cannot jump straight to active",
    !canTransitionLink("pending", "active"),
    "skips the review gate",
  );
  check("active can be suspended", canTransitionLink("active", "suspended"));
  check("suspension is recoverable", canTransitionLink("suspended", "active"));
  check("a state is not a legal transition to itself", !canTransitionLink("active", "active"));
  check("an unknown source state is rejected", !canTransitionLink("bogus" as never, "active"));

  // A link that exists but has no approved display name must not be sendable.
  // This is the "connected but unreachable" state that otherwise reads as a bug.
  check(
    "a link awaiting display-name review cannot send",
    !canSend({ status: "awaiting_review", isActive: true } as never),
  );
  check("a suspended link cannot send", !canSend({ status: "suspended", isActive: true } as never));
  check("an active link can send", canSend({ status: "active", isActive: true } as never));
  // Simulated is a transport choice, not a broken connection: the seeded demo
  // shop is simulated and must still count as sendable.
  check(
    "a simulated but active link can still send",
    canSend({ status: "active", isActive: true, isSimulated: true } as never),
  );

  const link = await createLink({
    tenantId: tenant.id,
    businessPhone: "+2348000009999",
    mode: "platform_provisioned",
    isSimulated: true,
  });
  check("a new link starts pending", link.status === "pending", link.status);
  check("the numbering model is stored per link", link.mode === "platform_provisioned");

  const bound = await recordNumberBound({
    linkId: link.id,
    wabaId: "TEST-WABA",
    phoneNumberId: "TEST_PNID_SMOKE",
    displayName: "Smoke Test Shop",
  });
  check(
    "binding a number without display-name approval lands in awaiting_review",
    bound.status === "awaiting_review",
    bound.status,
  );

  const found = await getLinkForPhoneNumber("TEST_PNID_SMOKE");
  check("an inbound phone number resolves to its link", found?.id === link.id);

  const activated = await setLinkStatus(link.id, "active", { reason: "display name approved" });
  check("awaiting_review -> active", activated.status === "active");
  check("the reason is retained for whoever is onboarding", activated.lastError === "display name approved");

  const suspended = await setLinkStatus(link.id, "suspended", { reason: "Meta restriction" });
  check("active -> suspended", suspended.status === "suspended");
  check("a suspended link stops sending", !canSend(suspended));

  let rejected = false;
  try {
    await setLinkStatus(link.id, "pending");
  } catch {
    rejected = true;
  }
  check("an illegal transition is refused, not silently applied", rejected);

  // Idempotent, so a replayed webhook cannot throw or corrupt state.
  const sameAgain = await setLinkStatus(link.id, "suspended");
  check("re-applying the same status is a no-op", sameAgain.status === "suspended");

  await db.delete(whatsappLinks).where(eq(whatsappLinks.id, link.id));

/* ---------------------------------------------------------------- */
  /* Email provider                                                    */
  /* ---------------------------------------------------------------- */

  console.log("\nEmail provider");

  const realFetch = globalThis.fetch;
  const savedEnv = {
    provider: process.env.EMAIL_PROVIDER,
    key: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM,
  };

  /** Replies with a canned Resend response and records what was sent. */
  function stubResend(status: number, body: unknown) {
    const seen: { auth?: string; payload?: Record<string, unknown> } = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen.auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      seen.payload = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Response;
    }) as typeof fetch;
    return seen;
  }

  process.env.EMAIL_PROVIDER = "resend";
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.EMAIL_FROM = "AfriAgent <no-reply@afriagent.test>";

  const testMessage = { to: "owner@ojota.local", subject: "Reset", text: "link" };

  const okSeen = stubResend(200, { id: "resend-abc123" });
  const ok = await sendEmail(testMessage);
  check("a 2xx with a message id counts as dispatched", ok.dispatched === true);
  check("the provider returns the message id", ok.detail === "resend-abc123");
  check(
    "the API key is sent as a bearer token",
    okSeen.auth === "Bearer re_test_key",
    okSeen.auth,
  );
  check(
    "the configured sender is used",
    okSeen.payload?.from === "AfriAgent <no-reply@afriagent.test>",
  );
  check(
    "the recipient is passed as an array",
    Array.isArray(okSeen.payload?.to) && (okSeen.payload?.to as string[])[0] === testMessage.to,
  );

  // The subtle one: Resend answers 200 with an error body for some rejections.
  // A status-code-only check would report this as sent.
  stubResend(200, { error: { name: "validation_error", message: "Invalid `to`" } });
  const rejected200 = await sendEmail(testMessage);
  check("a 200 that carries an error is NOT dispatched", rejected200.dispatched === false);
  check(
    "the provider error is surfaced",
    (rejected200.detail ?? "").includes("Invalid `to`"),
    rejected200.detail,
  );

  stubResend(422, { message: "Unverified domain" });
  const rejected422 = await sendEmail(testMessage);
  check("a 422 is NOT dispatched", rejected422.dispatched === false);
  check(
    "the failure reason is surfaced",
    (rejected422.detail ?? "").includes("Unverified domain"),
    rejected422.detail,
  );

  stubResend(200, {});
  const noId = await sendEmail(testMessage);
  check("a 2xx with no message id is NOT dispatched", noId.dispatched === false);

  // A transport failure must not become a 500 on a password reset form.
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  let threw = false;
  const networkFail = await sendEmail(testMessage).catch(() => {
    threw = true;
    return { dispatched: true };
  });
  check("sendEmail never throws on a network failure", threw === false);
  check("a network failure is reported as not dispatched", networkFail.dispatched === false);

  // Misconfiguration must not fall back to the console logger and look like
  // it worked.
  delete process.env.RESEND_API_KEY;
  check(
    "EMAIL_PROVIDER=resend without a key falls back to unconfigured",
    getEmailProvider().name === "unconfigured",
  );
  process.env.RESEND_API_KEY = "re_test_key";
  delete process.env.EMAIL_FROM;
  check(
    "EMAIL_PROVIDER=resend without a sender falls back to unconfigured",
    getEmailProvider().name === "unconfigured",
  );
  process.env.EMAIL_FROM = "AfriAgent <no-reply@afriagent.test>";
  check("a fully configured resend provider is selected", getEmailProvider().name === "resend");

  globalThis.fetch = realFetch;
  for (const [k, v] of [
    ["EMAIL_PROVIDER", savedEnv.provider],
    ["RESEND_API_KEY", savedEnv.key],
    ["EMAIL_FROM", savedEnv.from],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  // The links these emails carry are the whole point of the email.
  const vLink = "https://app.test/verify-email?token=tok123";
  check("the verification email carries its link", verificationEmail("Ojota", vLink).text.includes(vLink));
  const rLink = "https://app.test/reset-password?token=tok456";
  check("the reset email carries its link", passwordResetEmail(rLink).text.includes(rLink));
/* ---------------------------------------------------------------- */
  /* Platform settings and secrets                                    */
  /* ---------------------------------------------------------------- */

  console.log("\nPlatform settings and secrets");

  const savedEnvKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = randomBytes(32).toString("base64");

  const SECRET = "nvapi-testkey-0123456789abcdef";

  const sealed = encryptSecret(SECRET);
  check("a secret does not contain its plaintext", !sealed.includes("nvapi-testkey"));
  check("ciphertext is versioned", sealed.startsWith("v1."));
  check("a secret round-trips", decryptSecret(sealed) === SECRET);
  check("a fresh encrypt produces a different ciphertext", encryptSecret(SECRET) !== sealed);

  // A tampered ciphertext must fail to authenticate rather than return garbage
  // that would then be sent to NVIDIA as a credential.
  const parts = sealed.split(".");
  const tampered = [parts[0], parts[1], parts[2], Buffer.from("nonsense").toString("base64url")].join(".");
  let tamperRejected = false;
  try {
    decryptSecret(tampered);
  } catch {
    tamperRejected = true;
  }
  check("a tampered secret is rejected, not decoded", tamperRejected);

  let malformedRejected = false;
  try {
    decryptSecret("not-a-secret");
  } catch {
    malformedRejected = true;
  }
  check("a malformed secret is rejected", malformedRejected);

  // A rotated PLATFORM_SECRETS_KEY must not silently return garbage.
  const rotated = randomBytes(32).toString("base64");
  process.env.PLATFORM_SECRETS_KEY = rotated;
  let wrongKeyRejected = false;
  try {
    decryptSecret(sealed);
  } catch {
    wrongKeyRejected = true;
  }
  check("a rotated encryption key fails loudly", wrongKeyRejected);
  // Restore, or generate a fresh key if there was none set, so the persistence
  // checks below run against a usable key either way.
  process.env.PLATFORM_SECRETS_KEY = savedEnvKey ?? randomBytes(32).toString("base64");
  await setPlatformSecret("nvidia_api_key", SECRET);
  invalidatePlatformSettings();

  const readBack = await getPlatformSecret("nvidia_api_key");
  check("a stored secret reads back intact", readBack === SECRET);

  // The raw row must not hold plaintext -- that is the whole point of sealing.
  const rawRow = await getDb().then((d) =>
    d.select().from(platformSettings).where(eq(platformSettings.key, "nvidia_api_key")).limit(1),
  );
  check(
    "the stored row does not contain the plaintext key",
    !JSON.stringify(rawRow[0]?.value ?? {}).includes("nvapi-testkey"),
  );

  const described = await describePlatformSecret("nvidia_api_key");
  check("describe reports the secret as set", described.set === true);
  check(
    "describe never returns the value",
    !JSON.stringify(described).includes(SECRET),
    JSON.stringify(described),
  );
  check("describe shows only the last four characters", described.masked?.endsWith("cdef") === true);

  // Precedence: a stored value wins over the environment, which is what makes
  // rotation possible without a redeploy.
  const savedApiKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = "env-bootstrap-key-value";
  invalidatePlatformSettings();
  const withStore = await resolveProvider();
  check("a stored key takes precedence over the environment", !withStore.config.degraded);
  check("resolution is async but still returns a live provider", withStore.config.provider === "nvidia");

  await clearPlatformSecret("nvidia_api_key");
  invalidatePlatformSettings();
  const afterClear = await getPlatformSecret("nvidia_api_key");
  check("a cleared secret reads as absent rather than throwing", afterClear === null);
  check(
    "an absent secret falls back to describe as not set",
    (await describePlatformSecret("nvidia_api_key")).set === false,
  );

  // Non-secret settings round-trip as plain values.
  await setPlatformSetting("ai_model", "nvidia/some-model");
  invalidatePlatformSettings();
  check(
    "a plain setting round-trips",
    (await getPlatformSetting("ai_model", "fallback")) === "nvidia/some-model",
  );
  check(
    "an unset setting returns the fallback",
    (await getPlatformSetting("ai_setting_that_does_not_exist", "fallback")) === "fallback",
  );

  let refusedPlaintextSecret = false;
  try {
    await setPlatformSetting("nvidia_api_key", "oops");
  } catch {
    refusedPlaintextSecret = true;
  }
  check("a secret cannot be written through the plain-settings path", refusedPlaintextSecret);

  let unregisteredRefused = false;
  try {
    await setPlatformSecret("some_unregistered_key", "value");
  } catch {
    unregisteredRefused = true;
  }
  check("only registered keys can hold secrets", unregisteredRefused);

  await setPlatformSetting("ai_model", "");
  await setPlatformSetting("ai_base_url", "");
  await setPlatformSetting("ai_thinking_param", "");
  invalidatePlatformSettings();

  if (savedApiKey === undefined) delete process.env.NVIDIA_API_KEY;
  else process.env.NVIDIA_API_KEY = savedApiKey;

  /* ---------------------------------------------------------------- */
  /* Platform admin authorisation                                     */
  /* ---------------------------------------------------------------- */

  console.log("\nPlatform admin authorisation");

  const savedAdmins = process.env.PLATFORM_ADMIN_EMAILS;
  process.env.PLATFORM_ADMIN_EMAILS = "ops@example.com, founder@example.com";

  check("a listed email is a platform admin", isPlatformAdminEmail("ops@example.com"));
  check("matching is case-insensitive", isPlatformAdminEmail("OPS@Example.com"));
  check("an unlisted email is not", !isPlatformAdminEmail("tenant-owner@example.com"));
  check("a null email is not", !isPlatformAdminEmail(null));
  check("an undefined email is not", !isPlatformAdminEmail(undefined));

  // The allowlist must fail closed: an empty or missing list grants nothing,
  // rather than granting everyone.
  process.env.PLATFORM_ADMIN_EMAILS = "";
  check("an empty allowlist grants nobody", !isPlatformAdminEmail("ops@example.com"));

  delete process.env.PLATFORM_ADMIN_EMAILS;
  check("a missing allowlist grants nobody", !isPlatformAdminEmail("ops@example.com"));

  process.env.PLATFORM_ADMIN_EMAILS = savedAdmins ?? "";
  if (savedEnvKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
  if (savedAdmins === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
/* ---------------------------------------------------------------- */
  /* Order import                                                     */
  /* ---------------------------------------------------------------- */

  console.log("\nOrder import");

  // The report reads orders.totalMinor, so the total is the part that matters.
  // A wide export: one row per order, total supplied.
  const wideCsv = [
    "order_ref,placed_on,amount,status,sku,qty,price",
    "ORD-9001,2026-10-01,12500.00,paid,SUG-1KG,2,6250.00",
    "ORD-9002,01/10/2026,8000,delivered,BLUE-N,1,8000",
    "ORD-9003,2026-10-02,3000,cancelled,TEA-400,3,1000",
  ].join("\n");

  const wideDry = await importCsv(tenant.id, wideCsv, "orders", { dryRun: true });
  check("a dry run writes nothing", wideDry.created === 3 && wideDry.dryRun === true);
  check("a dry run reports no errors", wideDry.errors.length === 0, JSON.stringify(wideDry.errors));
  check("day-first dates are accepted", !wideDry.warnings.some((w) => w.includes("Could not read")));

  const wideCommit = await importCsv(tenant.id, wideCsv, "orders", { dryRun: false });
  check("a committed order import creates rows", wideCommit.created === 3, JSON.stringify(wideCommit));

  const [ord9001] = await db
    .select()
    .from(orders)
    .where(eq(orders.reference, "ORD-9001"));
  check("the supplied total is used verbatim", ord9001?.totalMinor === 1_250_000, String(ord9001?.totalMinor));
  check("an imported order is marked as such", ord9001?.source === "import");
  check("a paid order maps to fulfilled", ord9001?.status === "fulfilled");
  check("historical sales are dated from the file", ord9001?.placedAt.toISOString().startsWith("2026-10-01") === true);

  const [ord9003] = await db
    .select()
    .from(orders)
    .where(eq(orders.reference, "ORD-9003"));
  // Revenue correctness: cancelled orders are excluded from the sales report,
  // so mislabelling one inflates the number a shop is shown.
  check("a voided order maps to cancelled", ord9003?.status === "cancelled", ord9003?.status);

  // Re-importing the same file must update, not duplicate.
  const reimport = await importCsv(tenant.id, wideCsv, "orders", { dryRun: false });
  check("re-importing updates rather than duplicating", reimport.updated === 3 && reimport.created === 0);
  const orderCount = await db.select().from(orders).where(eq(orders.reference, "ORD-9001"));
  check("the row count is unchanged after a re-import", orderCount.length === 1);

  // A long export: one row per line item, reference repeated, no total column.
  const longCsv = [
    "order_ref,placed_on,sku,name,qty,price",
    "ORD-9100,2026-10-03,SUG-1KG,Granulated sugar,2,6250",
    "ORD-9100,2026-10-03,BLUE-N,Blue Naise,1,8000",
    "ORD-9101,2026-10-03,TEA-400,Beans,4,1000",
  ].join("\n");

  const longCommit = await importCsv(tenant.id, longCsv, "orders", { dryRun: false });
  check("a long export collapses to one row per order", longCommit.created === 2, JSON.stringify(longCommit));

  const [ord9100] = await db.select().from(orders).where(eq(orders.reference, "ORD-9100"));
  // 2 x 6250 + 1 x 8000 = 20500
  check(
    "a total is derived from the line items when the file has none",
    ord9100?.totalMinor === 2_050_000,
    String(ord9100?.totalMinor),
  );

  const lineCount = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, ord9100!.id));
  check("both line items are stored", lineCount.length === 2, String(lineCount.length));
  check(
    "line items link to the catalogue by SKU",
    lineCount.every((l) => l.productId !== null),
  );
  check(
    "line items snapshot the product name",
    lineCount.some((l) => l.description.toLowerCase().includes("blue")),
  );

  // Structural errors block a commit outright.
  const badCsv = "order_ref,placed_on,amount\n,2026-10-01,5000";
  const badResult = await importCsv(tenant.id, badCsv, "orders", { dryRun: false });
  check("a row with no reference is an error", badResult.errors.length === 1);
  check("the error names the row and the field", badResult.errors[0]?.field === "order_ref" && badResult.errors[0]?.row === 2);
  const blockedCount = await db.select().from(orders).where(eq(orders.reference, "ORD-9003"));
  check("an erroneous file creates nothing", blockedCount.length === 1);

  const badStatus = "order_ref,placed_on,amount,status\nORD-9200,2026-10-01,500,teleported";
  const badStatusResult = await importCsv(tenant.id, badStatus, "orders", { dryRun: true });
  check(
    "an unrecognised status is an error rather than a guess",
    badStatusResult.errors.some((e) => e.field === "status"),
    JSON.stringify(badStatusResult.errors),
  );

  // Undated history must not silently flatter the report.
  const undated = "order_ref,amount\nORD-9300,4200";
  const undatedResult = await importCsv(tenant.id, undated, "orders", { dryRun: true });
  check(
    "an order with no date warns that it was recorded as today",
    undatedResult.warnings.some((w) => w.includes("no date")),
    JSON.stringify(undatedResult.warnings),
  );

  // The reason this importer exists.
  const seededTotals = await currentTotals(tenant.id);
  check("order totals are now counted alongside products", typeof seededTotals.orders === "number" && seededTotals.orders > 0);

  // Clean up so the suite stays re-runnable.
  for (const ref of ["ORD-9001", "ORD-9002", "ORD-9003", "ORD-9100", "ORD-9101"]) {
    const [row] = await db.select({ id: orders.id }).from(orders).where(eq(orders.reference, ref));
    if (row) await db.delete(orderItems).where(eq(orderItems.orderId, row.id));
    await db.delete(orders).where(eq(orders.reference, ref));
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nSmoke test crashed:", err);
  process.exit(1);
});
