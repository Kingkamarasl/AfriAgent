import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  type Task,
  type TaskKind,
  taskEvents,
  tasks,
  tenants,
  usageLedger,
  users,
} from "@/db/schema";
import {
  assertTransition,
  BILLABLE_UNITS,
  billingPeriod,
  DEFAULT_RATE_CARD,
  requiresApprovalFor,
} from "./tasks";

type Db = Awaited<ReturnType<typeof getDb>>;

/* ------------------------------------------------------------------ */
/* Creation                                                             */
/* ------------------------------------------------------------------ */

export interface CreateTaskInput {
  tenantId: string;
  kind: TaskKind;
  title: string;
  origin?: "whatsapp" | "schedule" | "dashboard" | "api";
  requestText?: string;
  input?: Record<string, unknown>;
  conversationId?: string;
  conversationTurnId?: string;
  /** Force the approval gate; defaults to the per-kind policy. */
  requiresApproval?: boolean;
  isBillable?: boolean;
  billableUnits?: number;
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const db = await getDb();
  const [task] = await db
    .insert(tasks)
    .values({
      tenantId: input.tenantId,
      kind: input.kind,
      origin: input.origin ?? "whatsapp",
      status: "queued",
      title: input.title,
      requestText: input.requestText,
      input: input.input ?? {},
      requiresApproval: input.requiresApproval ?? requiresApprovalFor(input.kind),
      isBillable: input.isBillable ?? true,
      billableUnits: input.billableUnits ?? BILLABLE_UNITS[input.kind],
      conversationId: input.conversationId,
      conversationTurnId: input.conversationTurnId,
    })
    .returning();

  await logEvent(db, {
    tenantId: task.tenantId,
    taskId: task.id,
    toStatus: "queued",
    actor: input.origin === "whatsapp" ? "whatsapp" : "system",
    note: input.requestText ? `Requested: ${input.requestText}` : task.title,
  });

  return task;
}

/* ------------------------------------------------------------------ */
/* Transitions                                                          */
/* ------------------------------------------------------------------ */

export interface TransitionOptions {
  actor?: string;
  note?: string;
  /** Extra columns to write alongside the status change. */
  patch?: Partial<typeof tasks.$inferInsert>;
  meta?: Record<string, unknown>;
}

/**
 * The only way a task ever changes status.
 *
 * The UPDATE is guarded by `status = <from>`, so two concurrent workers
 * cannot both drive the same task forward: the loser updates zero rows and
 * gets a conflict rather than double-sending a message to a customer.
 */
export async function transitionTask(
  taskId: string,
  to: Parameters<typeof assertTransition>[1],
  options: TransitionOptions = {},
): Promise<Task> {
  const db = await getDb();

  const [current] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!current) throw new Error(`Task ${taskId} not found`);

  const from = current.status;
  assertTransition(from, to);

  const patch: Record<string, unknown> = {
    ...options.patch,
    status: to,
    updatedAt: new Date(),
  };
  if (to === "running") patch.startedAt = new Date();
  if (to === "sending") patch.attemptCount = sql`${tasks.attemptCount} + 1`;

  const [updated] = await db
    .update(tasks)
    .set(patch)
    .where(and(eq(tasks.id, taskId), eq(tasks.status, from)))
    .returning();

  if (!updated) {
    throw new Error(
      `Task ${taskId} changed concurrently (expected ${from}, wanted ${to})`,
    );
  }

  await logEvent(db, {
    tenantId: updated.tenantId,
    taskId,
    fromStatus: from,
    toStatus: to,
    actor: options.actor ?? "system",
    note: options.note,
    meta: options.meta ?? {},
  });

  return updated;
}

export async function approveTask(
  taskId: string,
  userId: string,
): Promise<Task> {
  const db = await getDb();
  const [user] = await db
    .select({ tenantId: users.tenantId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return transitionTask(taskId, "approved", {
    actor: `user:${userId}`,
    note: "Approved for sending",
    patch: { approvedBy: userId, approvedAt: new Date() },
    meta: { tenantId: user?.tenantId },
  });
}

export async function rejectTask(
  taskId: string,
  userId: string,
  reason: string,
): Promise<Task> {
  return transitionTask(taskId, "cancelled", {
    actor: `user:${userId}`,
    note: reason ? `Rejected: ${reason}` : "Rejected",
    patch: { rejectedAt: new Date(), rejectionReason: reason ?? null },
  });
}

/** Edit the draft and send it back through the approval gate. */
export async function reviseDraft(
  taskId: string,
  draftBody: string,
  userId: string,
): Promise<Task> {
  return transitionTask(taskId, "draft_ready", {
    actor: `user:${userId}`,
    note: "Draft edited",
    patch: { draftBody },
  });
}

export async function requestApproval(taskId: string, actor = "system"): Promise<Task> {
  return transitionTask(taskId, "pending_approval", { actor });
}

/* ------------------------------------------------------------------ */
/* Delivery                                                             */
/* ------------------------------------------------------------------ */

/**
 * Moves an approved task into `sent` and meters it.
 *
 * The actual provider call lives in `lib/whatsapp`; this function owns the
 * bookkeeping so that billing and the audit trail can never drift apart from
 * what was really delivered. Note it meters on `sent`, not on `created` --
 * businesses pay for work delivered.
 */
export async function markSent(
  taskId: string,
  result: { providerMessageId: string | null; deliveredVia: "cloud_api" | "simulated" },
): Promise<Task> {
  const task = await transitionTask(taskId, "sent", {
    actor: "system",
    note: `Delivered via ${result.deliveredVia}`,
    patch: { sentAt: new Date() },
    meta: { providerMessageId: result.providerMessageId },
  });

  if (task.isBillable) {
    await recordUsage(task);
  }

  return task;
}

export async function markFailed(taskId: string, error: string): Promise<Task> {
  return transitionTask(taskId, "failed", {
    actor: "system",
    note: error,
    patch: { error },
  });
}

/* ------------------------------------------------------------------ */
/* Billing                                                              */
/* ------------------------------------------------------------------ */

/**
 * Meter a completed task into the ledger. Called once, on `sent`.
 *
 * Guarded by a uniqueness check on (task_id) so a retried delivery cannot
 * double-charge the business.
 */
export async function recordUsage(task: Task, rateMinor?: number): Promise<void> {
  const db = await getDb();

  const [existing] = await db
    .select({ id: usageLedger.id })
    .from(usageLedger)
    .where(eq(usageLedger.taskId, task.id))
    .limit(1);
  if (existing) return;

  const [tenant] = await db
    .select({
      planMonthlyMinor: tenants.planMonthlyMinor,
      includedUnits: tenants.includedUnits,
      overageRateMinor: tenants.overageRateMinor,
    })
    .from(tenants)
    .where(eq(tenants.id, task.tenantId))
    .limit(1);

  // The ledger stores the unit price *at the time of the task*. If the rate
  // card changes mid-period, last month's entries still reconcile against
  // what the business was actually quoted.
  const rate =
    rateMinor ??
    tenant?.overageRateMinor ??
    DEFAULT_RATE_CARD.overageRateMinor;

  await db.insert(usageLedger).values({
    tenantId: task.tenantId,
    taskId: task.id,
    kind: task.kind,
    units: task.billableUnits,
    amountMinor: task.billableUnits * rate,
    period: billingPeriod(),
  });
}

export interface UsageSummary {
  period: string;
  /** Billable units consumed this period. */
  units: number;
  includedUnits: number;
  /** Units beyond the bundled allowance. */
  overageUnits: number;
  /** What the subscription costs. */
  planMinor: number;
  /** What the overage costs. */
  overageMinor: number;
  /** What we actually invoice: subscription + overage. */
  totalDueMinor: number;
  /**
   * Ledger value of the work delivered. Deliberately NOT what we bill --
   * this is the "here is what your subscription got you" number.
   */
  valueDeliveredMinor: number;
  currency: string;
  utilisationPct: number;
}

/**
 * The period invoice.
 *
 * The distinction that matters: `valueDeliveredMinor` is what the agent did,
 * `totalDueMinor` is what the business owes. Conflating them is how you end
 * up charging a shop owner ₦7,500 for one report.
 */
export async function summariseUsage(tenantId: string, period = billingPeriod()) {
  const db = await getDb();
  const [tenant] = await db
    .select({
      planMonthlyMinor: tenants.planMonthlyMinor,
      includedUnits: tenants.includedUnits,
      overageRateMinor: tenants.overageRateMinor,
      currency: tenants.currency,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const [row] = await db
    .select({
      units: sql<number>`coalesce(sum(${usageLedger.units}), 0)::int`,
      valueMinor: sql<number>`coalesce(sum(${usageLedger.amountMinor}), 0)::int`,
    })
    .from(usageLedger)
    .where(
      and(eq(usageLedger.tenantId, tenantId), eq(usageLedger.period, period)),
    );

  const includedUnits = tenant?.includedUnits ?? DEFAULT_RATE_CARD.includedUnits;
  const overageRateMinor =
    tenant?.overageRateMinor ?? DEFAULT_RATE_CARD.overageRateMinor;
  const units = row?.units ?? 0;

  const overageUnits = Math.max(0, units - includedUnits);
  const planMinor = tenant?.planMonthlyMinor ?? 0;
  const overageMinor = overageUnits * overageRateMinor;

  return {
    period,
    units,
    includedUnits,
    overageUnits,
    planMinor,
    overageMinor,
    totalDueMinor: planMinor + overageMinor,
    valueDeliveredMinor: row?.valueMinor ?? 0,
    currency: tenant?.currency ?? "NGN",
    utilisationPct: Math.min(
      100,
      Math.round((units / Math.max(includedUnits, 1)) * 100),
    ),
  } satisfies UsageSummary;
}

/* ------------------------------------------------------------------ */
/* Reads                                                                */
/* ------------------------------------------------------------------ */

export async function getTask(taskId: string): Promise<Task | undefined> {
  const db = await getDb();
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return row;
}

export async function listTasks(
  tenantId: string,
  opts: { status?: Task["status"][]; limit?: number } = {},
): Promise<Task[]> {
  const db = await getDb();
  const conds = [eq(tasks.tenantId, tenantId)];
  if (opts.status?.length) conds.push(inArray(tasks.status, opts.status));

  return db
    .select()
    .from(tasks)
    .where(and(...conds))
    .orderBy(desc(tasks.createdAt))
    .limit(opts.limit ?? 100);
}

export async function listTaskEvents(taskId: string) {
  const db = await getDb();
  return db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(taskEvents.createdAt);
}

/** The approval queue. Also the dashboard's primary view. */
export async function listApprovalQueue(tenantId: string, limit = 50) {
  return listTasks(tenantId, { status: ["pending_approval"], limit });
}

export async function listScheduledReady(now = new Date()) {
  const db = await getDb();
  return db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "queued"),
        lteOrNull(tasks.scheduledFor, now),
      ),
    )
    .limit(50);
}

function lteOrNull(column: typeof tasks.scheduledFor, value: Date) {
  return sql`(${column} is null or ${column} <= ${value})`;
}

/** Tasks that were metered in the last `days` days, for the activity feed. */
export async function recentActivity(tenantId: string, since: Date) {
  const db = await getDb();
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), gte(tasks.createdAt, since)))
    .orderBy(desc(tasks.createdAt))
    .limit(200);
}

/* ------------------------------------------------------------------ */
/* Internals                                                            */
/* ------------------------------------------------------------------ */

async function logEvent(
  db: Db,
  args: {
    tenantId: string;
    taskId: string;
    fromStatus?: Task["status"] | null;
    toStatus: Task["status"];
    actor: string;
    note?: string;
    meta?: Record<string, unknown>;
  },
) {
  await db.insert(taskEvents).values({
    tenantId: args.tenantId,
    taskId: args.taskId,
    fromStatus: args.fromStatus ?? null,
    toStatus: args.toStatus,
    actor: args.actor,
    note: args.note ?? null,
    meta: args.meta ?? {},
  });
}
