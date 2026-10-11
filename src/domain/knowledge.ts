import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  businessFacts,
  type FactStatus,
  type FactTier,
  type FactTopic,
} from "@/db/schema";

/**
 * Knowledge base persistence.
 *
 * The tenant id is an explicit argument, never inferred, and every write
 * carries it in the WHERE clause. That is deliberate: if tenant scoping lived
 * only inside a server action it would be untestable, and tenant scoping is
 * the one thing that must never be wrong.
 */

export const FACT_TOPICS: FactTopic[] = [
  "price",
  "service",
  "hours",
  "location",
  "policy",
  "contact",
  "delivery",
  "faq",
];

export type FactDraft = {
  subject: string;
  value: string;
  topic: FactTopic;
  tier: FactTier;
  provenance?: string;
};

export type KnowledgeResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

function validate(draft: FactDraft): string | null {
  if (draft.subject.trim().length < 2 || draft.subject.trim().length > 120) {
    return "Give the fact a short subject (2-120 characters).";
  }
  if (draft.value.trim().length < 3 || draft.value.trim().length > 2000) {
    return "The fact needs a value (3-2000 characters).";
  }
  if (!FACT_TOPICS.includes(draft.topic)) return "Choose a valid topic.";
  if (draft.tier !== "authoritative" && draft.tier !== "informational") {
    return "Choose a valid tier.";
  }
  return null;
}

/**
 * Facts are always created as drafts.
 *
 * Publishing is a separate, explicit act, because the moment a fact is
 * `active` the model may state it to a customer as fact.
 */
export async function createFact(
  tenantId: string,
  draft: FactDraft,
): Promise<KnowledgeResult> {
  const invalid = validate(draft);
  if (invalid) return { ok: false, error: invalid };

  const db = await getDb();
  const [row] = await db
    .insert(businessFacts)
    .values({
      tenantId,
      topic: draft.topic,
      tier: draft.tier,
      status: "draft",
      subject: draft.subject.trim(),
      value: draft.value.trim(),
      provenance: draft.provenance?.trim() || "entered by staff",
    })
    .returning({ id: businessFacts.id });

  return { ok: true, id: row!.id };
}

export async function updateFact(
  tenantId: string,
  factId: string,
  draft: FactDraft,
): Promise<KnowledgeResult> {
  const invalid = validate(draft);
  if (invalid) return { ok: false, error: invalid };

  const db = await getDb();
  const updated = await db
    .update(businessFacts)
    .set({
      topic: draft.topic,
      tier: draft.tier,
      subject: draft.subject.trim(),
      value: draft.value.trim(),
      updatedAt: new Date(),
    })
    .where(and(eq(businessFacts.id, factId), eq(businessFacts.tenantId, tenantId)))
    .returning({ id: businessFacts.id });

  if (updated.length === 0) {
    return { ok: false, error: "That fact does not belong to your business." };
  }
  return { ok: true, id: factId };
}

export async function setFactStatus(
  tenantId: string,
  factId: string,
  status: FactStatus,
): Promise<KnowledgeResult> {
  const db = await getDb();
  const updated = await db
    .update(businessFacts)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(businessFacts.id, factId), eq(businessFacts.tenantId, tenantId)))
    .returning({ id: businessFacts.id });

  if (updated.length === 0) {
    return { ok: false, error: "That fact does not belong to your business." };
  }
  return { ok: true, id: factId };
}

export async function deleteFact(
  tenantId: string,
  factId: string,
): Promise<KnowledgeResult> {
  const db = await getDb();
  const deleted = await db
    .delete(businessFacts)
    .where(and(eq(businessFacts.id, factId), eq(businessFacts.tenantId, tenantId)))
    .returning({ id: businessFacts.id });

  if (deleted.length === 0) {
    return { ok: false, error: "That fact does not belong to your business." };
  }
  return { ok: true, id: factId };
}

export async function listFacts(tenantId: string, limit = 200) {
  const db = await getDb();
  return db
    .select()
    .from(businessFacts)
    .where(eq(businessFacts.tenantId, tenantId))
    .orderBy(desc(businessFacts.updatedAt))
    .limit(limit);
}
