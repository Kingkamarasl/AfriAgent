"use server";

import { revalidatePath } from "next/cache";
import { getCurrentActor } from "@/lib/auth/session";
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

/** Resolve the actor from a verified, server-side session. */
export async function requireActor(): Promise<{ userId: string; tenantId: string; role: "owner" | "manager" | "staff" }> {
  const actor = await getCurrentActor();
  if (!actor) throw new Error("Please sign in to continue.");
  return { userId: actor.userId, tenantId: actor.tenantId, role: actor.role };
}

/** Only owners/managers may approve, reject, edit or retry consequential tasks. */
export async function requireManagerActor(): Promise<{ userId: string; tenantId: string; role: "owner" | "manager" }> {
  const actor = await requireActor();
  if (actor.role !== "owner" && actor.role !== "manager") throw new Error("You need owner or manager access to perform this action.");
  return { userId: actor.userId, tenantId: actor.tenantId, role: actor.role };
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
    const { userId, tenantId } = await requireManagerActor();
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
    const { userId, tenantId } = await requireManagerActor();
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
    const { userId, tenantId } = await requireManagerActor();
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
    const { tenantId } = await requireManagerActor();
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
    if (process.env.NODE_ENV === "production") return { ok: false, error: "The simulator is available in development only." };
    const actor = await getCurrentActor();
    if (!actor) return { ok: false, error: "Please sign in to continue." };
    const outcome = await handleInboundMessage({
      waId: from,
      body: text,
      messageId: `wamid.SIM.${nanoid()}`,
      timestamp: new Date(),
      tenantId: actor.tenantId,
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
