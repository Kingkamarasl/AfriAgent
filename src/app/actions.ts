"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { handleInboundMessage, sendTask } from "@/domain/pipeline";
import {
  approveTask,
  getTask,
  rejectTask,
  reviseDraft,
  transitionTask,
} from "@/domain/task-service";
import { nanoid } from "nanoid";

/**
 * Dashboard mutations.
 *
 * Approval is not a UI affordance -- it is the transition
 * pending_approval -> approved, guarded in `task-service`. A caller that
 * skips the gate gets a thrown `InvalidTransitionError` from the state
 * machine, not a silent send.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Resolves who is acting.
 *
 * PLACEHOLDER: with no auth layer this returns the seeded owner. Before this
 * ships, replace with a real session lookup and verify the actor's role AND
 * tenant on every call -- a dashboard that lets any authenticated user approve
 * another business's messages is the worst possible bug in this product.
 */
export async function requireActor(): Promise<{
  userId: string;
  tenantId: string;
}> {
  const db = await getDb();
  const [row] = await db
    .select({ id: users.id, tenantId: users.tenantId })
    .from(users)
    .innerJoin(tenants, eq(users.tenantId, tenants.id))
    .where(eq(users.role, "owner"))
    .limit(1);

  if (!row) throw new Error("No owner user found. Run `npm run db:seed`.");
  return { userId: row.id, tenantId: row.tenantId };
}

/** Guard against cross-tenant approval. */
async function assertOwnership(taskId: string, tenantId: string) {
  const task = await getTask(taskId);
  if (!task) throw new Error("Task not found");
  if (task.tenantId !== tenantId) {
    throw new Error("Not authorised for this business");
  }
  return task;
}

export async function approveAndSendAction(
  taskId: string,
): Promise<ActionResult> {
  try {
    const { userId, tenantId } = await requireActor();
    await assertOwnership(taskId, tenantId);

    await approveTask(taskId, userId);
    await sendTask(taskId, { actor: `user:${userId}` });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function rejectAction(
  taskId: string,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { userId, tenantId } = await requireActor();
    await assertOwnership(taskId, tenantId);

    const reason = String(formData.get("reason") ?? "").trim();
    await rejectTask(taskId, userId, reason);

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function reviseDraftAction(
  taskId: string,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { userId, tenantId } = await requireActor();
    await assertOwnership(taskId, tenantId);

    const draft = String(formData.get("draft") ?? "").trim();
    if (!draft) return { ok: false, error: "Draft cannot be empty" };

    await reviseDraft(taskId, draft, userId);
    // Editing sends it back through the gate; it is not auto-approved.
    await transitionTask(taskId, "pending_approval", {
      actor: `user:${userId}`,
      note: "Edited draft submitted for approval",
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function retryAction(taskId: string): Promise<ActionResult> {
  try {
    const { tenantId } = await requireActor();
    const task = await assertOwnership(taskId, tenantId);

    if (task.status !== "failed") {
      return { ok: false, error: `Cannot retry a ${task.status} task` };
    }

    await transitionTask(taskId, "queued", {
      actor: "system",
      note: "Retrying",
    });

    const { processTask } = await import("@/domain/pipeline");
    await processTask(taskId);

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Backs the playground's "send a WhatsApp message" box. */
export async function simulateInboundAction(
  text: string,
  from: string,
): Promise<{ ok: boolean; error?: string; taskCount?: number; role?: string }> {
  try {
    const outcome = await handleInboundMessage({
      waId: from,
      body: text,
      messageId: `wamid.SIM.${nanoid()}`,
      timestamp: new Date(),
    });

    revalidatePath("/", "layout");
    return {
      ok: true,
      taskCount: outcome.taskIds.length,
      role: outcome.role,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
