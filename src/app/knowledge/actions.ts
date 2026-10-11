"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/app/actions";
import {
  createFact,
  deleteFact,
  setFactStatus,
  updateFact,
  type FactDraft,
} from "@/domain/knowledge";
import type { FactStatus, FactTier, FactTopic } from "@/db/schema";

/**
 * Knowledge base authoring actions.
 *
 * Thin by design: authorise from the session, then hand off to
 * `domain/knowledge`, where the tenant scoping lives and is covered by tests.
 * A rule that only exists inside a server action is a rule nobody can prove.
 *
 * Two things make this a safety surface rather than a settings screen:
 *
 *  - Facts are created as drafts. Publishing is deliberate, because an
 *    `active` fact is something the assistant may state as truth.
 *  - `tier` decides what the model may *do* with the text. Marking a prose
 *    paragraph authoritative is how a business promises a policy it never made,
 *    so the UI spells that out at the point of the choice.
 */

export interface FactFormState {
  ok: boolean;
  error?: string;
}

/** Owners and managers only; a shop's prices are not a staffer's to change. */
async function requireEditor(): Promise<string> {
  const actor = await requireActor();
  if (actor.role !== "owner" && actor.role !== "manager") {
    throw new Error("Only owners and managers can change business information.");
  }
  return actor.tenantId;
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function readDraft(formData: FormData): FactDraft {
  return {
    subject: text(formData, "subject"),
    value: text(formData, "value"),
    topic: text(formData, "topic") as FactTopic,
    tier: text(formData, "tier") as FactTier,
    provenance: text(formData, "provenance"),
  };
}

function fail(error: unknown, fallback: string): FactFormState {
  return {
    ok: false,
    error: error instanceof Error ? error.message : fallback,
  };
}

export async function createFactAction(
  _prev: FactFormState,
  formData: FormData,
): Promise<FactFormState> {
  try {
    const tenantId = await requireEditor();
    const result = await createFact(tenantId, readDraft(formData));
    if (!result.ok) return result;

    revalidatePath("/knowledge");
    return { ok: true };
  } catch (error) {
    return fail(error, "Could not save the fact.");
  }
}

export async function updateFactAction(
  _prev: FactFormState,
  formData: FormData,
): Promise<FactFormState> {
  try {
    const tenantId = await requireEditor();
    const result = await updateFact(
      tenantId,
      text(formData, "id"),
      readDraft(formData),
    );
    if (!result.ok) return result;

    revalidatePath("/knowledge");
    return { ok: true };
  } catch (error) {
    return fail(error, "Could not update the fact.");
  }
}

/** Publish, unpublish or archive. Archiving beats deleting: history matters. */
export async function setFactStatusAction(
  _prev: FactFormState,
  formData: FormData,
): Promise<FactFormState> {
  try {
    const tenantId = await requireEditor();
    const result = await setFactStatus(
      tenantId,
      text(formData, "id"),
      text(formData, "status") as FactStatus,
    );
    if (!result.ok) return result;

    revalidatePath("/knowledge");
    return { ok: true };
  } catch (error) {
    return fail(error, "Could not change the status.");
  }
}

export async function deleteFactAction(
  _prev: FactFormState,
  formData: FormData,
): Promise<FactFormState> {
  try {
    const tenantId = await requireEditor();
    const result = await deleteFact(tenantId, text(formData, "id"));
    if (!result.ok) return result;

    revalidatePath("/knowledge");
    return { ok: true };
  } catch (error) {
    return fail(error, "Could not delete the fact.");
  }
}
