import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  contacts,
  conversations,
  messages,
  tasks,
  tenants,
  users,
  whatsappLinks,
  type Task,
  type Tenant,
} from "@/db/schema";
import {
  CS_WINDOW_MS,
  isInsideServiceWindow,
  sendMessage,
  type OutboundMessage,
  type SendResult,
} from "@/lib/whatsapp/client";
import type { TemplateSend } from "@/lib/whatsapp/templates";
import {
  normalisePhone,
  resolveSenderRole,
  routeCustomerMessage,
  routeMessage,
  type PlannedTask,
} from "./intents";
import { executeTask } from "./execute";
import { createTask, markFailed, markSent, transitionTask } from "./task-service";

/**
 * The agent pipeline.
 *
 *   inbound WhatsApp message
 *     -> resolve tenant + sender role
 *     -> plan one or more Tasks
 *     -> execute each Task against tenant data
 *     -> approval gate (or auto-send when the kind is low-risk)
 *     -> deliver, meter, audit
 *
 * No step sends anything without either explicit human approval or a
 * low-risk classification. The gate is the product.
 */

/* ------------------------------------------------------------------ */
/* Inbound                                                              */
/* ------------------------------------------------------------------ */

export interface InboundContext {
  waId: string;
  body: string;
  messageId: string;
  timestamp: Date;
  displayName?: string;
  phoneNumberId?: string;
  /**
   * Simulator only. The tenant resolved from the caller's verified session --
   * never anything supplied in the request body. `phoneNumberId` takes
   * precedence and is the production path.
   */
  tenantId?: string;
}

export interface InboundOutcome {
  tenantId: string;
  role: "owner" | "customer" | "unknown" | "";
  conversationId: string;
  /** Every task fanned out from this one message. */
  taskIds: string[];
  insideServiceWindow: boolean;
}

const EMPTY: InboundOutcome = {
  tenantId: "",
  role: "unknown",
  conversationId: "",
  taskIds: [],
  insideServiceWindow: false,
};

/**
 * Meta retries any webhook it does not get a 200 for, which would duplicate
 * work and double-charge the business. This short-circuits replays by wamid.
 */
async function isDuplicate(messageId: string): Promise<boolean> {
  const db = await getDb();
  const [existing] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.providerMessageId, messageId))
    .limit(1);
  return Boolean(existing);
}

export async function handleInboundMessage(
  ctx: InboundContext,
): Promise<InboundOutcome> {
  const db = await getDb();

  if (await isDuplicate(ctx.messageId)) return EMPTY;

  const tenant = await resolveTenant(ctx);
  if (!tenant) {
    // Nothing is attached to this number. Dropping silently is deliberate:
    // replying "unrecognised number" to a stranger on a public number is worse
    // than saying nothing.
    console.warn(
      `[whatsapp] no tenant for phone_number_id=${ctx.phoneNumberId ?? "none"}`,
    );
    return EMPTY;
  }

  const contact = await upsertContact(tenant.id, ctx);
  const conversation = await upsertConversation(
    tenant.id,
    contact.id,
    ctx.timestamp,
  );

  const owners = await db
    .select({ id: users.id, phone: users.phone })
    .from(users)
    .where(eq(users.tenantId, tenant.id));

  const resolved = resolveSenderRole({
    waId: ctx.waId,
    owners,
    contactsByWaId: new Map([[normalisePhone(ctx.waId), contact.id]]),
  });

  const isOwner = resolved.role === "owner";

  const planned: PlannedTask[] = isOwner
    ? routeMessage(ctx.body)
    : [routeCustomerMessage(ctx.body)];

  // One id groups every task produced by this single message. Must be a real
  // UUID -- the column is typed `uuid`, not `text`.
  const turnId = crypto.randomUUID();

  await db.insert(messages).values({
    tenantId: tenant.id,
    conversationId: conversation.id,
    providerMessageId: ctx.messageId,
    direction: "inbound",
    status: "received",
    body: ctx.body,
  });

  const taskIds: string[] = [];
  for (const plan of planned) {
    const task = await createTask({
      tenantId: tenant.id,
      kind: plan.kind,
      title: plan.title,
      origin: "whatsapp",
      requestText: plan.requestText,
      input: plan.input,
      conversationId: conversation.id,
      conversationTurnId: turnId,
      // Customer-facing replies are always consequential: a price or promise
      // made to a customer is the shop's word, not ours.
      requiresApproval: !isOwner || plan.kind !== "sales_report",
    });

    // Inline for now. Production moves this to a durable queue
    // (Inngest / Trigger.dev) so a slow report never delays Meta's webhook ack.
    await processTask(task.id);
    taskIds.push(task.id);
  }

  return {
    tenantId: tenant.id,
    role: isOwner ? "owner" : "customer",
    conversationId: conversation.id,
    taskIds,
    insideServiceWindow: isInsideServiceWindow(conversation.windowExpiresAt),
  };
}

/* ------------------------------------------------------------------ */
/* Execution                                                            */
/* ------------------------------------------------------------------ */

/**
 * Run a task's executor, persist the result, then either park it for approval
 * or deliver it immediately when the kind is low-risk.
 */
export async function processTask(taskId: string): Promise<void> {
  const db = await getDb();
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) return;

  await transitionTask(taskId, "running", { actor: "system", note: "Executing" });

  try {
    const result = await executeTask(task);

    await transitionTask(taskId, "draft_ready", {
      actor: "system",
      note: result.summary,
      patch: {
        // The delivery plan is persisted alongside the data, not beside it.
        // Anything an executor returns outside `data` is invisible to
        // `sendTask` later, which silently degrades a batch task into a
        // single free-form message.
        result: {
          ...result.data,
          delivery: result.delivery ?? null,
        },
        draftBody: result.draftBody,
      },
    });

    if (task.requiresApproval) {
      await transitionTask(taskId, "pending_approval", {
        actor: "system",
        note: "Waiting for a human before anything is sent",
      });
      return;
    }

    await sendTask(taskId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(taskId, message);
    console.error(`[tasks] ${taskId} failed:`, message);
  }
}

/* ------------------------------------------------------------------ */
/* Delivery                                                             */
/* ------------------------------------------------------------------ */

/** Persisted `task.result` shape. Parsed defensively -- it is JSON in the DB. */
interface StoredResult {
  delivery?: {
    recipients?: Array<{ waId: string; template: TemplateSend; preview: string }>;
    template?: TemplateSend;
  };
}

export interface SendTaskOptions {
  /** Record the attempt without touching the network. */
  dryRun?: boolean;
  actor?: string;
}

export async function sendTask(taskId: string, opts: SendTaskOptions = {}) {
  const db = await getDb();
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const conversation = task.conversationId
    ? (
        await db
          .select({
            waId: contacts.waId,
            windowExpiresAt: conversations.windowExpiresAt,
          })
          .from(conversations)
          .innerJoin(contacts, eq(conversations.contactId, contacts.id))
          .where(eq(conversations.id, task.conversationId))
          .limit(1)
      )[0]
    : undefined;

  const to = conversation?.waId;
  if (!to) {
    await markFailed(taskId, "No recipient conversation for this task");
    throw new Error(`Task ${taskId} has no recipient`);
  }

  const insideWindow = isInsideServiceWindow(conversation?.windowExpiresAt ?? null);
  const { delivery } = (task.result ?? {}) as StoredResult;

  await transitionTask(taskId, "sending", {
    actor: opts.actor ?? "system",
    note: "Delivering",
  });

  let lastResult: SendResult | null = null;

  try {
    if (delivery?.recipients?.length) {
      // Batch task: one approved template per customer, e.g. 6 chased invoices.
      for (const recipient of delivery.recipients) {
        const outbound: OutboundMessage = { to: recipient.waId, template: recipient.template };
        lastResult = await sendMessage(outbound, {
          insideServiceWindow: true, // Templates need no window.
          dryRun: opts.dryRun,
        });
        await recordOutbound(task, outbound, lastResult, recipient.template.template);
      }
    } else if (delivery?.template) {
      const outbound: OutboundMessage = { to, template: delivery.template };
      lastResult = await sendMessage(outbound, {
        insideServiceWindow: true,
        dryRun: opts.dryRun,
      });
      await recordOutbound(task, outbound, lastResult, delivery.template.template);
    } else {
      // Free-form text. Throws if the 24h window has closed -- by design.
      const outbound: OutboundMessage = { to, text: task.draftBody ?? "" };
      lastResult = await sendMessage(outbound, {
        insideServiceWindow: insideWindow,
        dryRun: opts.dryRun,
      });
      await recordOutbound(task, outbound, lastResult);
    }

    if (!lastResult) throw new Error("Nothing to send");
    return await markSent(taskId, lastResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(taskId, message);
    throw error;
  }
}

async function recordOutbound(
  task: Task,
  outbound: OutboundMessage,
  result: SendResult,
  templateName?: string,
) {
  if (!task.conversationId) return;
  const db = await getDb();

  await db.insert(messages).values({
    tenantId: task.tenantId,
    conversationId: task.conversationId,
    providerMessageId: result.providerMessageId,
    direction: "outbound",
    status: "sent",
    body:
      outbound.text ??
      (outbound.template ? `[template:${outbound.template.template}]` : ""),
    templateName: templateName ?? null,
    // Unique per (task, recipient): a retried delivery cannot create a
    // duplicate row, which would corrupt the conversation view.
    dedupeKey: `${task.id}:${outbound.to}`,
  });
}

/* ------------------------------------------------------------------ */
/* Delivery receipts                                                    */
/* ------------------------------------------------------------------ */

export async function applyDeliveryStatus(update: {
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  error?: string;
}) {
  const db = await getDb();
  const [updated] = await db
    .update(messages)
    .set({
      status: update.status,
      error: update.error ?? null,
    })
    .where(eq(messages.providerMessageId, update.providerMessageId))
    .returning();
  return updated;
}

/* ------------------------------------------------------------------ */
/* Lookups                                                              */
/* ------------------------------------------------------------------ */

async function resolveTenant(ctx: InboundContext): Promise<Tenant | null> {
  const db = await getDb();

  // Production: Meta tells us which number the message arrived on, and that
  // number is bound to exactly one business. This is the authoritative path.
  if (ctx.phoneNumberId) {
    const [row] = await db
      .select({ tenant: tenants })
      .from(whatsappLinks)
      .innerJoin(tenants, eq(whatsappLinks.tenantId, tenants.id))
      .where(
        and(
          eq(whatsappLinks.phoneNumberId, ctx.phoneNumberId),
          eq(whatsappLinks.isActive, true),
        ),
      )
      .limit(1);
    return row?.tenant ?? null;
  }

  // Simulator: the caller supplies the tenant taken from its own verified
  // session.
  //
  // This must NOT fall through to "first tenant in the table". With more than
  // one registered business that silently resolves a signed-in user's
  // simulated message into someone else's tenant -- the exact cross-tenant
  // leak the session layer exists to prevent.
  if (ctx.tenantId) {
    const [row] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId))
      .limit(1);
    return row ?? null;
  }

  // Dev fallback only: the single seeded demo shop.
  const [row] = await db.select().from(tenants).limit(1);
  return row ?? null;
}

async function upsertContact(tenantId: string, ctx: InboundContext) {
  const db = await getDb();
  const [existing] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.waId, ctx.waId)))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(contacts)
      .set({ lastSeenAt: ctx.timestamp })
      .where(eq(contacts.id, existing.id))
      .returning();
    return updated ?? existing;
  }

  const [created] = await db
    .insert(contacts)
    .values({
      tenantId,
      waId: ctx.waId,
      displayName: ctx.displayName ?? null,
      lastSeenAt: ctx.timestamp,
    })
    .returning();
  return created;
}

async function upsertConversation(tenantId: string, contactId: string, timestamp: Date) {
  const db = await getDb();
  const [existing] = await db
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.tenantId, tenantId), eq(conversations.contactId, contactId)),
    )
    .limit(1);

  // Every inbound message re-opens Meta's 24-hour customer service window.
  const windowExpiresAt = new Date(timestamp.getTime() + CS_WINDOW_MS);

  if (existing) {
    const [updated] = await db
      .update(conversations)
      .set({ windowExpiresAt, lastInboundAt: timestamp })
      .where(eq(conversations.id, existing.id))
      .returning();
    return updated ?? existing;
  }

  const [created] = await db
    .insert(conversations)
    .values({ tenantId, contactId, windowExpiresAt, lastInboundAt: timestamp })
    .returning();
  return created;
}
