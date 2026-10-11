import type { TaskKind } from "@/db/schema";

/* ------------------------------------------------------------------ */
/* Sender role resolution                                               */
/* ------------------------------------------------------------------ */

export type SenderRole =
  | { role: "owner"; userId: string }
  | { role: "customer"; contactId: string }
  | { role: "unknown" };

/**
 * Two very different conversations arrive on the same WhatsApp number:
 *
 *   owner    -> "Show me today's sales"      (a command for the business)
 *   customer -> "Do you have milk in stock?" (support for the shop's customers)
 *
 * The owner's phone matches a `users.phone` row for the tenant; everyone else
 * is a customer of that shop. Getting this wrong means a customer's "what's
 * the price of rice" gets answered with the owner's revenue figures, so it is
 * resolved explicitly before any routing happens.
 */
export function resolveSenderRole(args: {
  waId: string;
  owners: Array<{ id: string; phone: string | null }>;
  contactsByWaId: Map<string, string>;
}): SenderRole {
  const normalized = normalisePhone(args.waId);

  for (const owner of args.owners) {
    if (owner.phone && normalisePhone(owner.phone) === normalized) {
      return { role: "owner", userId: owner.id };
    }
  }

  const contactId = args.contactsByWaId.get(normalized);
  if (contactId) return { role: "customer", contactId };
  return { role: "unknown" };
}

/** WhatsApp wa_ids arrive in a few shapes; compare on trailing digits. */
export function normalisePhone(raw: string): string {
  return raw.replace(/[^\d]/g, "").slice(-12);
}

/* ------------------------------------------------------------------ */
/* Owner command routing                                                */
/* ------------------------------------------------------------------ */

export interface PlannedTask {
  kind: TaskKind;
  title: string;
  requestText: string;
  input: Record<string, unknown>;
  /**
   * Whether this is worth charging for. Greetings, acknowledgements and
   * emoji still get a task so there is an audit trail, but they must not
   * consume the customer's plan allowance.
   */
  billable?: boolean;
}

/**
 * Messages that carry no work.
 *
 * Without this, every "ok" or 👍 a customer sends becomes a billable task. The
 * business sees their allowance draining on noise and blames the agent.
 */
const LOW_VALUE_PATTERN =
  /^(hi|hey|hello|yo|sup|ok|okay|k|kk|yes|yeah|no|nope|nah|sure|thanks|thank ?u|ty|cheers|great|perfect|awesome|nice|good (morning|afternoon|evening|night|day)|dear|please|pls)\b|^[\p{So}\p{Sk}]+$/iu;

export function isLowValueMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.length > 60) return false; // Long enough to hide real intent.
  return LOW_VALUE_PATTERN.test(trimmed);
}

interface Rule {
  kind: TaskKind;
  title: string;
  test: RegExp;
  input?: Record<string, unknown>;
}

/**
 * Ordered: first match wins, so the more specific patterns sit above the
 * broader ones. Purely deterministic for now -- every branch is covered by
 * tests and the behaviour is identical with or without an LLM configured.
 *
 * Swapping in a model classifier later means replacing `routeMessage`'s body
 * with a tool-call loop and returning the same `PlannedTask[]`. Nothing
 * downstream changes.
 */
const OWNER_RULES: Rule[] = [
  {
    kind: "handoff",
    title: "Hand off to a human",
    test: /\b(human|person|real person|actual person|agent|speak to (someone|a human)|manager|supervisor)\b/i,
  },
  {
    kind: "sales_report",
    title: "Sales report",
    test: /\b(sales|revenue|turnover|what did i (make|sell)|how much did i|total sales|takings)\b/i,
  },
  {
    kind: "invoice_reminder",
    title: "Chase overdue invoices",
    test: /\b(invoice|invoices|overdue|unpaid|outstanding|debt|debts|owe|owe me|payment|chase)\b/i,
  },
  {
    kind: "low_stock",
    title: "Low stock report",
    test: /\b(low stock|running out|running low|stock level|inventory|what.?s left|out of stock|remaining)\b/i,
  },
  {
    kind: "daily_summary",
    title: "Daily summary",
    test: /\b(summary|digest|brief me|briefing|how are we doing|update me|catch me up|status)\b/i,
  },
  {
    kind: "appointment_book",
    title: "Book appointment",
    test: /\b(book|appointment|schedule|slot|booking|reservation)\b/i,
  },
  {
    kind: "order_create",
    title: "Create order",
    test: /\b(order|place an order|new order|record (a )?(sale|order))\b/i,
  },
];

/**
 * Split a multi-intent message into clauses.
 *
 * "Show me today's sales, remind overdue invoices and tell me what's running
 *  low" is three Tasks, not one -- and it is billed as three.
 *
 * Splits on commas, semicolons, newlines, and the explicit connectives
 * ("and also", "and then"). A bare " and " is deliberately NOT a separator,
 * because it is usually internal to a clause ("bread and milk"). The `, and`
 * form is handled by the comma branch, so natural phrasings still split.
 */
export function splitIntents(text: string): string[] {
  return text
    .split(/\s*(?:,\s*(?:and\s+)?|\band also\b|\band then\b|;|\n+|\s•\s)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

export function routeMessage(text: string): PlannedTask[] {
  const clauses = splitIntents(text);
  const planned: PlannedTask[] = [];
  const seen = new Set<TaskKind>();
  const billable = !isLowValueMessage(text);

  for (const clause of clauses.length ? clauses : [text]) {
    const rule = OWNER_RULES.find((r) => r.test.test(clause));
    if (!rule || seen.has(rule.kind)) continue;
    seen.add(rule.kind);
    planned.push({
      kind: rule.kind,
      title: rule.title,
      requestText: clause,
      input: rule.input ?? {},
      billable,
    });
  }

  if (planned.length === 0) {
    planned.push({
      kind: "unknown",
      title: "Unrecognised request",
      requestText: text,
      input: {},
      billable,
    });
  }

  return planned;
}

/* ------------------------------------------------------------------ */
/* Customer support routing                                             */
/* ------------------------------------------------------------------ */

const CUSTOMER_RULES: Rule[] = [
  {
    kind: "appointment_book",
    title: "Appointment request",
    test: /\b(book|appointment|schedule|slot|booking|available)\b/i,
  },
  {
    kind: "low_stock",
    title: "Availability question",
    test: /\b(do you have|have you got|in stock|available|stock)\b/i,
  },
  {
    kind: "invoice_reminder",
    title: "Invoice enquiry",
    test: /\b(my invoice|invoice|payment|owe|balance|receipt)\b/i,
  },
  {
    kind: "handoff",
    title: "Request for a human",
    test: /\b(human|person|agent|manager|talk to someone)\b/i,
  },
];

/**
 * Customer messages become tasks too, but they are *support* tasks: the agent
 * drafts a reply, and anything that commits the shop to a price, a discount
 * or a booking still routes through approval.
 */
export function routeCustomerMessage(text: string): PlannedTask {
  const rule = CUSTOMER_RULES.find((r) => r.test.test(text));
  if (!rule) {
    return {
      kind: "customer_question",
      title: "Customer question",
      requestText: text,
      input: {},
      billable: !isLowValueMessage(text),
    };
  }
  return {
    kind: rule.kind,
    title: rule.title,
    requestText: text,
    input: {},
    billable: !isLowValueMessage(text),
  };
}
