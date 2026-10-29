import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { whatsappLinks, type WhatsappLink } from "@/db/schema";

/**
 * WhatsApp connection lifecycle.
 *
 * Deliberately number-agnostic. Both numbering models -- the shop brings its
 * own number, or AfriAgent provisions one -- move through this same state
 * machine, so choosing between them is a per-tenant `mode` rather than a fork
 * in the code.
 *
 *   pending -> awaiting_review -> active
 *      |             |
 *      +-------------+-> failed
 *      |
 *      +-> suspended   (Meta restricted the account, or the shop churned)
 *
 * Nothing here talks to Meta, and nothing here stores credentials. Those wait
 * on the BSP decision. What this buys is that the numbering model stops being
 * a code fork -- so picking wrong later is a data change, not a rewrite.
 */

export class InvalidLinkTransitionError extends Error {
  constructor(
    readonly from: WhatsappLink["status"],
    readonly to: WhatsappLink["status"],
  ) {
    super(`Illegal WhatsApp link transition: ${from} -> ${to}`);
    this.name = "InvalidLinkTransitionError";
  }
}

const TRANSITIONS: Record<WhatsappLink["status"], readonly WhatsappLink["status"][]> = {
  pending: ["awaiting_review", "failed", "suspended"],
  // Meta reviewing the display name. Worth naming explicitly: the number and
  // credentials can be ready while the shop still cannot be messaged, which
  // otherwise reads as a bug during onboarding.
  awaiting_review: ["active", "failed", "suspended"],
  active: ["suspended", "failed"],
  // Recovery is allowed rather than terminal. Meta lifts restrictions, and a
  // shop that churned and came back should not need a new row.
  suspended: ["awaiting_review", "active", "failed"],
  failed: ["pending", "awaiting_review"],
};

export function canTransitionLink(
  from: WhatsappLink["status"],
  to: WhatsappLink["status"],
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Whether this link is in a state where outbound is permitted.
 *
 * `isSimulated` is deliberately not consulted. Whether a send reaches Meta is
 * the transport's decision (`client.ts` picks simulator vs Cloud API), not a
 * property of the connection -- and the seeded demo link is simulated, so
 * treating simulation as "cannot send" would lock the demo shop out of the one
 * path it can actually use.
 */
export function canSend(link: WhatsappLink): boolean {
  return link.status === "active" && link.isActive;
}

export async function createLink(args: {
  tenantId: string;
  businessPhone: string;
  mode?: WhatsappLink["mode"];
  /** Simulated links never contact Meta. */
  isSimulated?: boolean;
}): Promise<WhatsappLink> {
  const db = await getDb();
  const [row] = await db
    .insert(whatsappLinks)
    .values({
      tenantId: args.tenantId,
      businessPhone: args.businessPhone,
      mode: args.mode ?? "self_provisioned",
      status: "pending",
      isSimulated: args.isSimulated ?? true,
    })
    .returning();
  return row;
}

/**
 * Records that a number has been bound to this link.
 *
 * Lands on `awaiting_review` unless Meta has already approved the display
 * name. Treating "connected" as "usable" is how a shop spends two days
 * wondering why nobody can reach them.
 */
export async function recordNumberBound(args: {
  linkId: string;
  wabaId?: string;
  phoneNumberId: string;
  displayName?: string;
  displayNameApproved?: boolean;
}): Promise<WhatsappLink> {
  const db = await getDb();

  const [link] = await db
    .select()
    .from(whatsappLinks)
    .where(eq(whatsappLinks.id, args.linkId))
    .limit(1);
  if (!link) throw new Error(`WhatsApp link ${args.linkId} not found`);

  const status = args.displayNameApproved ? "active" : "awaiting_review";
  if (link.status !== "pending" && !canTransitionLink(link.status, status)) {
    throw new InvalidLinkTransitionError(link.status, status);
  }

  const [updated] = await db
    .update(whatsappLinks)
    .set({
      wabaId: args.wabaId ?? link.wabaId,
      phoneNumberId: args.phoneNumberId,
      displayName: args.displayName ?? link.displayName,
      displayNameStatus: args.displayNameApproved ? "APPROVED" : "PENDING",
      status,
      isSimulated: false,
      lastError: null,
    })
    .where(eq(whatsappLinks.id, args.linkId))
    .returning();

  return updated;
}

export async function setLinkStatus(
  linkId: string,
  to: WhatsappLink["status"],
  opts: { reason?: string } = {},
): Promise<WhatsappLink> {
  const db = await getDb();

  const [link] = await db
    .select()
    .from(whatsappLinks)
    .where(eq(whatsappLinks.id, linkId))
    .limit(1);
  if (!link) throw new Error(`WhatsApp link ${linkId} not found`);

  // No-op rather than an illegal self-transition, so callers can be idempotent.
  if (link.status === to) return link;

  if (!canTransitionLink(link.status, to)) {
    throw new InvalidLinkTransitionError(link.status, to);
  }

  // The status is in the WHERE clause so two concurrent writers cannot both
  // read `pending` and both believe they moved it to `active`.
  const [updated] = await db
    .update(whatsappLinks)
    .set({ status: to, lastError: opts.reason ?? null })
    .where(and(eq(whatsappLinks.id, linkId), eq(whatsappLinks.status, link.status)))
    .returning();

  if (!updated) throw new Error(`WhatsApp link ${linkId} changed concurrently`);
  return updated;
}

/**
 * Reacts to Meta's `account_update` webhook.
 *
 * A restriction here is account-wide and escalates quickly -- 1 day, then 5,
 * then 30, then locked. Recording it lets the dashboard stop the shop sending
 * before customers start seeing the failure.
 */
export async function applyMetaAccountRestriction(args: {
  phoneNumberId: string;
  restricted: boolean;
  reason?: string;
}): Promise<void> {
  const link = await getLinkForPhoneNumber(args.phoneNumberId);
  if (!link) return;

  // Only ever moves between the two restriction states. A webhook that says
  // "not restricted" is not evidence the link was ever working -- a shop still
  // pending onboarding should not be promoted to `active` by an unrelated
  // account_update event.
  const target = args.restricted ? "suspended" : "active";
  if (link.status === target) return;

  await setLinkStatus(link.id, target, { reason: args.reason });
}

export async function getLinkForPhoneNumber(
  phoneNumberId: string,
): Promise<WhatsappLink | undefined> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(whatsappLinks)
    .where(
      and(
        eq(whatsappLinks.phoneNumberId, phoneNumberId),
        eq(whatsappLinks.isActive, true),
      ),
    )
    .limit(1);
  return row;
}

export async function listLinks(tenantId: string): Promise<WhatsappLink[]> {
  const db = await getDb();
  return db
    .select()
    .from(whatsappLinks)
    .where(eq(whatsappLinks.tenantId, tenantId))
    .orderBy(sql`${whatsappLinks.createdAt} desc`);
}