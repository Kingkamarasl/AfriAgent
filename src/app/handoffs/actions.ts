"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/app/actions";
import { claimHandoff, resolveHandoff } from "@/domain/handoffs";

/**
 * Handover queue actions.
 *
 * Any signed-in user of the business can claim or resolve -- the whole point
 * is that a staffer at the counter can pick up what the assistant could not
 * answer. Both operations derive the tenant from the session, so there is no
 * path where a user of one business can touch another's queue.
 */

export interface HandoffActionState {
  ok: boolean;
  error?: string;
  notice?: string;
}

export async function claimHandoffAction(
  handoffId: string,
): Promise<HandoffActionState> {
  try {
    const actor = await requireActor();
    const result = await claimHandoff(handoffId, actor.userId, actor.tenantId);
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath("/handoffs");
    revalidatePath("/");
    return { ok: true, notice: "Claimed. It is yours." };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not claim it.",
    };
  }
}

export async function resolveHandoffAction(
  _prev: HandoffActionState,
  formData: FormData,
): Promise<HandoffActionState> {
  try {
    const actor = await requireActor();
    const id = String(formData.get("id") ?? "");
    const note = String(formData.get("note") ?? "").trim();

    const result = await resolveHandoff(id, actor.tenantId, note);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath("/handoffs");
    revalidatePath("/");
    return { ok: true, notice: "Closed. Thanks for picking it up." };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not close it.",
    };
  }
}
