import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { contacts, conversations, handoffs, type Handoff } from "@/db/schema";

/**
 * The human handover queue.
 *
 * The assistant escalates on purpose. This is the other half of that decision:
 * a handover that nobody can see is not a handover, it is the assistant
 * quietly failing and telling the customer otherwise.
 */

export interface OpenHandoff {
  tenantId: string;
  taskId?: string;
  conversationId?: string;
  contactId?: string;
  reason: string;
  context?: Record<string, unknown>;
}

/**
 * Records a handover.
 *
 * De-duplicated per task: a retried task execution must not produce two queue
 * entries for the same conversation, or staff chase the same customer twice.
 */
export async function openHandoff(args: OpenHandoff): Promise<Handoff> {
  const db = await getDb();

  if (args.taskId) {
    const [existing] = await db
      .select()
      .from(handoffs)
      .where(
        and(
          eq(handoffs.taskId, args.taskId),
          inArray(handoffs.status, ["open", "claimed"]),
        ),
      )
      .limit(1);
    if (existing) return existing;
  }

  // Resolve the waiting customer from the conversation when the caller did
  // not supply it, so every escalation lands with a name and a number rather
  // than an anonymous queue entry nobody can act on.
  let contactId = args.contactId ?? null;
  if (!contactId && args.conversationId) {
    const [conversation] = await db
      .select({ contactId: conversations.contactId })
      .from(conversations)
      .where(eq(conversations.id, args.conversationId))
      .limit(1);
    contactId = conversation?.contactId ?? null;
  }

  const [row] = await db
    .insert(handoffs)
    .values({
      tenantId: args.tenantId,
      taskId: args.taskId ?? null,
      conversationId: args.conversationId ?? null,
      contactId,
      reason: args.reason,
      context: args.context ?? {},
      status: "open",
    })
    .returning();

  return row;
}

/**
 * Claims a handover for a member of staff.
 *
 * The status guard in the WHERE clause makes this safe against two staff
 * clicking at the same moment: the loser's update matches zero rows and is
 * told the handover is already taken, rather than silently stealing it.
 */
export async function claimHandoff(
  handoffId: string,
  userId: string,
  tenantId: string,
): Promise<{ ok: boolean; error?: string }> {
  const db = await getDb();

  const claimed = await db
    .update(handoffs)
    .set({ status: "claimed", assignedTo: userId, claimedAt: new Date() })
    .where(
      and(
        eq(handoffs.id, handoffId),
        eq(handoffs.tenantId, tenantId),
        eq(handoffs.status, "open"),
      ),
    )
    .returning({ id: handoffs.id });

  if (claimed.length === 0) {
    return { ok: false, error: "Already claimed by someone else." };
  }
  return { ok: true };
}

export async function resolveHandoff(
  handoffId: string,
  tenantId: string,
  note: string,
): Promise<{ ok: boolean; error?: string }> {
  const db = await getDb();

  const resolved = await db
    .update(handoffs)
    .set({
      status: "resolved",
      resolvedAt: new Date(),
      resolutionNote: note || null,
    })
    .where(
      and(
        eq(handoffs.id, handoffId),
        eq(handoffs.tenantId, tenantId),
        inArray(handoffs.status, ["open", "claimed"]),
      ),
    )
    .returning({ id: handoffs.id });

  if (resolved.length === 0) {
    return { ok: false, error: "That handover is already closed." };
  }
  return { ok: true };
}

export interface HandoffListItem extends Handoff {
  contactName: string | null;
  contactWaId: string | null;
  contactPhone: string | null;
}

export async function listHandoffs(
  tenantId: string,
  statuses: Array<Handoff["status"]> = ["open", "claimed"],
): Promise<HandoffListItem[]> {
  const db = await getDb();

  return db
    .select({
      id: handoffs.id,
      tenantId: handoffs.tenantId,
      taskId: handoffs.taskId,
      conversationId: handoffs.conversationId,
      contactId: handoffs.contactId,
      reason: handoffs.reason,
      context: handoffs.context,
      status: handoffs.status,
      assignedTo: handoffs.assignedTo,
      claimedAt: handoffs.claimedAt,
      resolvedAt: handoffs.resolvedAt,
      resolutionNote: handoffs.resolutionNote,
      createdAt: handoffs.createdAt,
      contactName: contacts.displayName,
      contactWaId: contacts.waId,
      contactPhone: contacts.phone,
    })
    .from(handoffs)
    .leftJoin(contacts, eq(handoffs.contactId, contacts.id))
    .where(
      and(eq(handoffs.tenantId, tenantId), inArray(handoffs.status, statuses)),
    )
    .orderBy(asc(handoffs.createdAt))
    .limit(100);
}

/** Count for the nav badge. */
export async function openHandoffCount(tenantId: string): Promise<number> {
  const db = await getDb();
  const rows = await listHandoffs(tenantId);
  return rows.length;
}
