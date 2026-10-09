import { and, eq, gte } from "drizzle-orm";
import { getDb } from "@/db/client";
import { contacts, conversations, tasks, tenants, users } from "@/db/schema";
import { startOfDayInZone } from "@/lib/time";
import { createTask } from "./task-service";
import { processTask } from "./pipeline";

/**
 * Scheduled work.
 *
 * The daily summary is the retention hook: it proves value every morning
 * without the shop doing anything. It is also the first task that originates
 * from the platform rather than from a message, which exposes a real gap --
 * there is no inbound message to hang a conversation off, so we have to find
 * (or create) the thread between the business and its own owner.
 */

export interface ScheduledRunResult {
  tenantId: string;
  tenantName: string;
  taskId?: string;
  status: "ran" | "skipped" | "failed";
  reason?: string;
}

/**
 * Finds or creates the conversation between a tenant and its owner.
 *
 * The owner's `wa_id` lives on `users.phone`; the messaging tables key off
 * `contacts`. Bridging the two once, here, keeps every scheduled task from
 * having to invent its own delivery address.
 */
export async function ensureOwnerConversation(tenantId: string): Promise<string> {
  const db = await getDb();

  const [owner] = await db
    .select({ id: users.id, phone: users.phone, name: users.name })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, "owner")))
    .limit(1);

  if (!owner?.phone) {
    throw new Error(`Tenant ${tenantId} has no owner with a WhatsApp number`);
  }

  const [existingContact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.waId, owner.phone)))
    .limit(1);

  const contact =
    existingContact ??
    (
      await db
        .insert(contacts)
        .values({
          tenantId,
          waId: owner.phone,
          displayName: owner.name,
          // Deliberately not `lastSeenAt`: the owner has not just messaged.
        })
        .returning()
    )[0];

  const [existingConversation] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.contactId, contact.id),
      ),
    )
    .limit(1);

  if (existingConversation) return existingConversation.id;

  // No window: we are initiating, not replying. The summary therefore has to
  // go out as an approved template -- which `runDailySummary` already builds.
  const [created] = await db
    .insert(conversations)
    .values({ tenantId, contactId: contact.id, windowExpiresAt: null })
    .returning();

  return created.id;
}

/**
 * Runs the daily summary for every tenant that has not had one today.
 *
 * Idempotent per tenant per day: safe to call from a cron that retries, and
 * safe to call twice by hand.
 */
export async function runDailySummaries(now = new Date()): Promise<ScheduledRunResult[]> {
  const db = await getDb();
  const allTenants = await db.select().from(tenants);
  const results: ScheduledRunResult[] = [];

  for (const tenant of allTenants) {
    const since = startOfDayInZone(now, tenant.timezone);

    const [alreadyRan] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.tenantId, tenant.id),
          eq(tasks.kind, "daily_summary"),
          gte(tasks.createdAt, since),
        ),
      )
      .limit(1);

    if (alreadyRan) {
      results.push({
        tenantId: tenant.id,
        tenantName: tenant.name,
        status: "skipped",
        reason: "already sent today",
      });
      continue;
    }

    try {
      const conversationId = await ensureOwnerConversation(tenant.id);

      const task = await createTask({
        tenantId: tenant.id,
        kind: "daily_summary",
        title: "Daily summary",
        origin: "schedule",
        requestText: "Scheduled daily summary",
        conversationId,
        // Auto-sent. The recipient is the shop's own owner, so this carries no
        // risk of committing the business to a customer -- and requiring a
        // click every morning is exactly the approval fatigue that makes
        // shops switch the agent off. Anything customer-facing stays gated.
        requiresApproval: false,
      });

      await processTask(task.id);

      results.push({
        tenantId: tenant.id,
        tenantName: tenant.name,
        taskId: task.id,
        status: "ran",
      });
    } catch (error) {
      results.push({
        tenantId: tenant.id,
        tenantName: tenant.name,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
