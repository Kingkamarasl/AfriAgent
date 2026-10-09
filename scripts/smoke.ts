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
import { eq } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { messages, tenants, usageLedger, users } from "../src/db/schema";
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

let passed = 0;
let failed = 0;

/** The seeded owner's WhatsApp wa_id. */
const OWNER_WA_ID = "2348010000001";

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

    const outboundTemplates = await db
      .select({ templateName: messages.templateName })
      .from(messages)
      .where(eq(messages.tenantId, tenant.id));

    const chased = outboundTemplates.filter((m) => m.templateName === "invoice_reminder").length;
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
  const messy = [
    "sku,name,unit,stock,reorder_level,unit_price",
    'SMK-1,"Bread, sliced and seeded",loaf,4,8,650', // comma inside quotes
    "SMK-2,Milk powder,tin,3,12,4200",
    "",
  ].join("\r\n"); // CRLF, like Excel on Windows

  const parsed = parseCsv(messy);
  check("CSV parser keeps quoted commas intact", parsed[1]?.[1] === "Bread, sliced and seeded");
  check("CSV parser handles CRLF", parsed.length === 3, `${parsed.length} rows`);

  const bom = "\uFEFFsku,name\r\nSMK-3,Thing\r\n";
  check("CSV parser strips the Excel BOM", parseCsv(bom)[1]?.[0] === "SMK-3");

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

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nSmoke test crashed:", err);
  process.exit(1);
});
