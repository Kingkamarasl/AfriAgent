import { and, eq, gte, lt, ne, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  contacts,
  invoices,
  orderItems,
  orders,
  products,
  tenants,
} from "@/db/schema";
import { formatMoney } from "@/lib/money";
import { startOfDayInZone } from "@/lib/time";
import { buildTemplatePreview, type TemplateSend } from "@/lib/whatsapp/templates";
import type { Task } from "@/db/schema";

/**
 * Task executors.
 *
 * Each one reads authorised, tenant-scoped data and produces a result plus,
 * where relevant, a draft to send. Deterministic and testable today; the
 * shape is what an LLM-backed implementation would fill in later without any
 * change to the surrounding engine.
 */

/** How a finished task reaches someone. Persisted with the task. */
export interface TaskDelivery {
  /** One message per recipient, e.g. six chased invoices. */
  recipients?: Array<{ waId: string; template: TemplateSend; preview: string }>;
  /** A single message to the conversation's contact. */
  template?: TemplateSend;
}

export interface TaskResult {
  /** One-line description for the dashboard and audit log. */
  summary: string;
  data: Record<string, unknown>;
  /**
   * Delivery plan, if this task sends anything. Nested rather than top-level
   * because `data` is what gets persisted -- a top-level `recipients` field
   * would be silently dropped and the task would fall back to free-form text.
   */
  delivery?: TaskDelivery;
  /** Human-readable preview of what will be sent, if anything. */
  draftBody?: string;
  /** Report tasks are informational; they do not send anything. */
  isInformational?: boolean;
}

const ORDER_TERMINAL_EXCLUDE = ne(orders.status, "cancelled");

async function tenantCtx(tenantId: string) {
  const db = await getDb();
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new Error(`Unknown tenant ${tenantId}`);
  return { db, tenant };
}

/* ------------------------------------------------------------------ */
/* sales_report                                                         */
/* ------------------------------------------------------------------ */

export async function runSalesReport(tenantId: string): Promise<TaskResult> {
  const { db, tenant } = await tenantCtx(tenantId);

  const start = startOfDayInZone(new Date(), tenant.timezone);
  const end = new Date(start.getTime() + 86_400_000 - 1);

  const [totals] = await db
    .select({
      revenueMinor: sql<number>`coalesce(sum(${orders.totalMinor}), 0)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        ORDER_TERMINAL_EXCLUDE,
        gte(orders.placedAt, start),
        lt(orders.placedAt, end),
      ),
    );

  // Same window yesterday, for a like-for-like comparison.
  const yStart = new Date(start.getTime() - 86_400_000);
  const yEnd = new Date(start.getTime() - 1);
  const [yTotals] = await db
    .select({ revenueMinor: sql<number>`coalesce(sum(${orders.totalMinor}), 0)::int` })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        ORDER_TERMINAL_EXCLUDE,
        gte(orders.placedAt, yStart),
        lt(orders.placedAt, yEnd),
      ),
    );

  const revenueByProduct = sql<number>`sum(${orderItems.quantity} * ${orderItems.unitPriceMinor})::int`;
  const topProducts = await db
    .select({
      description: orderItems.description,
      quantity: sql<number>`sum(${orderItems.quantity})::int`,
      revenueMinor: revenueByProduct,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        ORDER_TERMINAL_EXCLUDE,
        gte(orders.placedAt, start),
        lt(orders.placedAt, end),
      ),
    )
    .groupBy(orderItems.description)
    .orderBy(sql`${revenueByProduct} desc`)
    .limit(5);

  const revenueMinor = totals?.revenueMinor ?? 0;
  const prevMinor = yTotals?.revenueMinor ?? 0;
  const changePct = prevMinor === 0 ? null : ((revenueMinor - prevMinor) / prevMinor) * 100;

  const lines = [
    `*Today's sales* (${tenant.name})`,
    ``,
    `Revenue: ${formatMoney(revenueMinor, tenant.currency)}`,
    `Orders: ${totals?.count ?? 0}`,
    changePct === null
      ? `Yesterday: no sales recorded`
      : `Yesterday: ${formatMoney(prevMinor, tenant.currency)} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}%)`,
  ];

  if (topProducts.length) {
    lines.push(``, `*Top items*`);
    for (const p of topProducts) {
      lines.push(`- ${p.description} — ${p.quantity} × ${formatMoney(p.revenueMinor, tenant.currency)}`);
    }
  }

  if (revenueMinor === 0) {
    lines.push(``, `_No orders recorded yet today._`);
  }

  return {
    summary: `${formatMoney(revenueMinor, tenant.currency)} across ${totals?.count ?? 0} orders`,
    isInformational: true,
    draftBody: lines.join("\n"),
    data: {
      revenueMinor,
      orderCount: totals?.count ?? 0,
      previousDayMinor: prevMinor,
      changePct,
      topProducts,
      windowStart: start.toISOString(),
    },
  };
}

/* ------------------------------------------------------------------ */
/* invoice_reminder                                                     */
/* ------------------------------------------------------------------ */

export async function runInvoiceReminder(
  tenantId: string,
  task: Task,
): Promise<TaskResult> {
  const { db, tenant } = await tenantCtx(tenantId);
  const now = new Date();

  const overdue = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      amountMinor: invoices.amountMinor,
      dueOn: invoices.dueOn,
      contactId: invoices.contactId,
      waId: contacts.waId,
      contactName: contacts.displayName,
    })
    .from(invoices)
    .leftJoin(contacts, eq(invoices.contactId, contacts.id))
    .where(
      and(
        eq(invoices.tenantId, tenantId),
        sql`${invoices.status} in ('sent', 'overdue')`,
        lt(invoices.dueOn, now),
        sql`${contacts.waId} is not null`,
      ),
    )
    .limit(100);

  if (overdue.length === 0) {
    return {
      summary: "No overdue invoices — nothing to chase",
      draftBody: "Good news: there are no overdue invoices right now.",
      data: { overdueCount: 0 },
      isInformational: true,
    };
  }

  const totalOutstandingMinor = overdue.reduce((s, i) => s + i.amountMinor, 0);

  // One message per customer, each an approved template: these go out outside
  // the 24h window and must never be free-form text.
  const recipients = overdue.map((inv) => {
    const name = inv.contactName || "there";
    const amount = formatMoney(inv.amountMinor, tenant.currency);
    const link = `https://pay.afriagent.app/i/${inv.number}`;
    return {
      waId: inv.waId!,
      template: {
        template: "invoice_reminder" as const,
        values: [name, inv.number, amount, link] as [string, string, string, string],
      },
      preview: buildTemplatePreview({
        template: "invoice_reminder",
        values: [name, inv.number, amount, link],
      }),
    };
  });

  const oldest = overdue.reduce((a, b) =>
    a.dueOn && b.dueOn && a.dueOn < b.dueOn ? a : b,
  );
  const daysOverdue = oldest.dueOn
    ? Math.floor((now.getTime() - oldest.dueOn.getTime()) / 86_400_000)
    : 0;

  return {
    summary: `${overdue.length} overdue invoice${overdue.length === 1 ? "" : "s"} — ${formatMoney(totalOutstandingMinor, tenant.currency)} outstanding`,
    draftBody:
      `*Overdue invoices*\n\n` +
      overdue
        .map(
          (i) =>
            `- ${i.contactName ?? i.waId}: ${i.number} — ${formatMoney(i.amountMinor, tenant.currency)}`,
        )
        .join("\n") +
      `\n\nTotal: ${formatMoney(totalOutstandingMinor, tenant.currency)}` +
      (daysOverdue > 0 ? `\nOldest is ${daysOverdue} days overdue.` : ""),
    // Nested under `delivery` so it survives persistence. If this were a
    // top-level field, these templates would be dropped and the task would
    // send one free-form message to the owner instead of chasing anyone.
    delivery: { recipients },
    data: {
      overdueCount: overdue.length,
      totalOutstandingMinor,
      oldestDueOn: oldest.dueOn,
      invoices: overdue,
    },
  };
}

/* ------------------------------------------------------------------ */
/* low_stock                                                            */
/* ------------------------------------------------------------------ */

export async function runLowStock(tenantId: string): Promise<TaskResult> {
  const { db, tenant } = await tenantCtx(tenantId);

  const low = await db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      unit: products.unit,
      stockQty: products.stockQty,
      reorderLevel: products.reorderLevel,
      unitPriceMinor: products.unitPriceMinor,
    })
    .from(products)
    .where(
      and(
        eq(products.tenantId, tenantId),
        eq(products.isActive, true),
        sql`${products.stockQty} <= ${products.reorderLevel}`,
      ),
    )
    .limit(50);

  const valueAtRiskMinor = low.reduce((s, p) => s + p.stockQty * p.unitPriceMinor, 0);

  if (low.length === 0) {
    return {
      summary: "All products are above their reorder level",
      draftBody: "Stock levels look healthy — nothing has hit its reorder point.",
      data: { lowStockCount: 0 },
      isInformational: true,
    };
  }

  const body = [
    `*Running low* (${tenant.name})`,
    ``,
    ...low.map(
      (p) =>
        `- ${p.name} (${p.sku}): ${p.stockQty} ${p.unit} left — reorder at ${p.reorderLevel}`,
    ),
  ].join("\n");

  return {
    summary: `${low.length} product${low.length === 1 ? "" : "s"} at or below reorder level`,
    draftBody: body,
    data: { lowStockCount: low.length, valueAtRiskMinor, products: low },
  };
}

/* ------------------------------------------------------------------ */
/* daily_summary                                                        */
/* ------------------------------------------------------------------ */

export async function runDailySummary(tenantId: string): Promise<TaskResult> {
  const [sales, low, chasing] = await Promise.all([
    runSalesReport(tenantId),
    runLowStock(tenantId),
    runInvoiceReminder(tenantId, {} as Task),
  ]);

  const body = [
    (sales.draftBody ?? "").split("\n").slice(2).join("\n").trim(),
    ``,
    low.summary,
    chasing.summary,
  ].join("\n");

  return {
    summary: `Daily summary: ${sales.summary}`,
    draftBody: `*Daily summary* — ${new Date().toISOString().slice(0, 10)}\n\n${body}`,
    // A scheduled summary is initiating, not replying, so it always leaves
    // outside the 24h window and must be an approved template.
    delivery: { template: { template: "daily_summary", values: ["AfriAgent", body] } },
    data: { sales: sales.data, lowStock: low.data, invoices: chasing.data },
  };
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                           */
/* ------------------------------------------------------------------ */

export async function executeTask(task: Task): Promise<TaskResult> {
  switch (task.kind) {
    case "sales_report":
      return runSalesReport(task.tenantId);
    case "invoice_reminder":
      return runInvoiceReminder(task.tenantId, task);
    case "low_stock":
      return runLowStock(task.tenantId);
    case "daily_summary":
      return runDailySummary(task.tenantId);
    default:
      return {
        summary: `No executor for ${task.kind} yet`,
        data: {},
        draftBody: `AfriAgent is not able to handle "${task.title}" yet. A member of the team has been notified.`,
        isInformational: true,
      };
  }
}
