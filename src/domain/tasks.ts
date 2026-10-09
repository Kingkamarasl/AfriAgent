import type { TaskKind, TaskStatus } from "@/db/schema";

/* ------------------------------------------------------------------ */
/* The state machine                                                    */
/* ------------------------------------------------------------------ */

/**
 * Legal transitions. Anything not listed here is rejected at the service
 * layer -- this map is the single source of truth for the lifecycle, so the
 * UI, the API and the scheduled workers can never disagree about what may
 * happen next.
 *
 * The shape of the graph is the product promise:
 *   - Nothing is sent before it is `approved`.
 *   - `requiresApproval=false` shortcuts draft_ready -> sending.
 *   - `sent` and `cancelled` are terminal; `failed` can be re-queued.
 */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "cancelled", "failed"],
  running: ["draft_ready", "pending_approval", "sending", "failed", "cancelled"],
  draft_ready: ["pending_approval", "sending", "cancelled", "failed"],
  pending_approval: ["approved", "draft_ready", "cancelled", "failed"],
  approved: ["sending", "cancelled", "failed"],
  sending: ["sent", "failed"],
  sent: [],
  failed: ["queued", "cancelled"],
  cancelled: [],
};

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "sent",
  "cancelled",
];

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextStatuses(from: TaskStatus): readonly TaskStatus[] {
  return TRANSITIONS[from] ?? [];
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`Illegal task transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return;
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Statuses that mean "a human needs to look at this". */
export const NEEDS_ATTENTION: readonly TaskStatus[] = ["pending_approval", "failed"];

/* ------------------------------------------------------------------ */
/* Metering                                                             */
/* ------------------------------------------------------------------ */

/**
 * Billable units per task kind. Weighted so that work which costs more to
 * compute (a multi-table sales report) is charged more than a lookup.
 *
 * These weights are the pricing model. Tune them against real LLM + WhatsApp
 * costs before quoting a plan to anyone.
 */
export const BILLABLE_UNITS: Record<TaskKind, number> = {
  sales_report: 3,
  daily_summary: 4,
  invoice_reminder: 2,
  low_stock: 2,
  customer_question: 1,
  order_create: 2,
  appointment_book: 2,
  handoff: 1,
  unknown: 1,
};

/**
 * Default rate card.
 *
 * The pricing model is a subscription that *bundles* billable units, plus a
 * metered overage beyond that. The important invariant:
 *
 *     planMonthlyMinor / includedUnits  ===  overageRateMinor
 *
 * If those two disagree the business either never pays for overuse or pays a
 * rate unrelated to what they were quoted, and both destroy trust.
 * `assertRateCardCoherent` enforces it.
 *
 * These numbers are a starting point for a Nigerian SME, not a researched
 * price. Tune against real LLM and WhatsApp costs before selling.
 */
export const DEFAULT_RATE_CARD = {
  /** ₦15,000 / month. */
  planMonthlyMinor: 1_500_000,
  /** Units bundled in the subscription. */
  includedUnits: 200,
  /** ₦75 / unit beyond the allowance -- equals the bundled unit price. */
  overageRateMinor: 7_500,
} as const;

export interface RateCard {
  planMonthlyMinor: number;
  includedUnits: number;
  overageRateMinor: number;
}

export class IncoherentRateCardError extends Error {
  constructor(readonly rate: RateCard) {
    super(
      `Rate card is incoherent: a ${rate.planMonthlyMinor / 100} plan over ` +
        `${rate.includedUnits} units implies ` +
        `${rate.planMonthlyMinor / Math.max(rate.includedUnits, 1) / 100} per unit, ` +
        `but overage is charged at ${rate.overageRateMinor / 100}.`,
    );
    this.name = "IncoherentRateCardError";
  }
}

/** Throws if the bundled unit price and the overage rate disagree. */
export function assertRateCardCoherent(rate: RateCard): void {
  if (rate.includedUnits <= 0) throw new IncoherentRateCardError(rate);
  const implied = rate.planMonthlyMinor / rate.includedUnits;
  // A small band is allowed: rounding to the nearest naira is normal.
  if (Math.abs(implied - rate.overageRateMinor) > 50) {
    throw new IncoherentRateCardError(rate);
  }
}

/**
 * Kinds that always require human approval before anything is sent.
 * Anything that commits the business to a customer-facing promise does.
 */
export const ALWAYS_REQUIRES_APPROVAL: readonly TaskKind[] = [
  "invoice_reminder",
  "order_create",
  "appointment_book",
  "unknown",
];

export function requiresApprovalFor(kind: TaskKind): boolean {
  return ALWAYS_REQUIRES_APPROVAL.includes(kind);
}

/* ------------------------------------------------------------------ */
/* Human-readable labels                                                */
/* ------------------------------------------------------------------ */

export const TASK_KIND_LABEL: Record<TaskKind, string> = {
  sales_report: "Sales report",
  invoice_reminder: "Invoice reminder",
  low_stock: "Low stock check",
  daily_summary: "Daily summary",
  customer_question: "Customer question",
  order_create: "Create order",
  appointment_book: "Book appointment",
  handoff: "Human handoff",
  unknown: "Unrecognised request",
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  draft_ready: "Draft ready",
  pending_approval: "Awaiting approval",
  approved: "Approved",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Billing period key, e.g. "2026-10". */
export function billingPeriod(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
