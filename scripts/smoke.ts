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
import { tenants, usageLedger, users } from "../src/db/schema";
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
import { InvalidTransitionError, requiresApprovalFor } from "../src/domain/tasks";

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
    `got ${outcome.taskIds.length}`,
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

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nSmoke test crashed:", err);
  process.exit(1);
});
