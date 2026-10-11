import type { ToolFact } from "./tools";

/**
 * The grounding layer.
 *
 * Everything above this file is best-effort. This is the part that decides
 * whether a customer ever sees an answer.
 *
 * The rule the product sells is "it never invents a price". A prompt
 * instruction is not enough to make that true -- models are confidently wrong
 * -- so the decision is made here, against facts the tools actually returned,
 * using no model judgement at all.
 */

export type GroundingVerdict =
  /** Safe to send. At least one authoritative fact backs the answer. */
  | "answerable"
  /** Safe to send, but built only on background prose. Reserved for non-factual topics. */
  | "informational"
  /** Must not be sent. Hand to a human. */
  | "escalate";

export interface GroundingInput {
  draft: string;
  question: string;
  /** Facts returned by tools during this answer, de-duplicated. */
  returnedFacts: ToolFact[];
  /** Present when the model explicitly asked for a human. */
  escalatedByModel?: { reason: string };
  /** Present when the model called escalate_to_human. */
  escalateToolReason?: string;
  /** Set when the provider or budget failed before an answer existed. */
  failureReason?: string;
}

export interface GroundingDecision {
  verdict: GroundingVerdict;
  reason: string;
  citations: string[];
}

/**
 * Topics where a prose answer would be a commitment.
 *
 * A friendly FAQ sentence about returns is still a promise about returns. These
 * topics therefore require an authoritative fact or they escalate.
 */
const COMMITMENT_TOPICS = new Set(["price", "hours", "policy", "delivery", "location"]);

/**
 * Currency amounts written out.
 *
 * Deliberately narrow: bare digits are far too common in ordinary replies
 * ("we have 5 in stock") to be treated as a price claim. A currency marker or
 * the word "naira" is an unambiguous statement about money.
 */
const CURRENCY_CLAIM =
  /(?:[₦$€£]\s?\d[\d,.]*)|\b(?:NGN|USD|GHS|KES|ZAR|LRD|SLE|GMD)\s?\d[\d,.]*|\b(?:naira|dollars?|bucks?)\b/i;

const CITATION = /\[fact:([A-Za-z0-9:_-]+)\]/g;

export function extractCitations(draft: string): string[] {
  const found = new Set<string>();
  for (const match of draft.matchAll(CITATION)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

export function evaluateGrounding(input: GroundingInput): GroundingDecision {
  const { draft, returnedFacts } = input;

  // 1. Nothing was produced, or the pipeline already failed.
  if (input.failureReason) {
    return { verdict: "escalate", reason: input.failureReason, citations: [] };
  }

  // 2. The model decided it needed a human.
  if (input.escalateToolReason || input.escalatedByModel) {
    return {
      verdict: "escalate",
      reason: input.escalateToolReason ?? input.escalatedByModel?.reason ?? "model requested a human",
      citations: [],
    };
  }

  if (!draft.trim()) {
    return { verdict: "escalate", reason: "empty answer", citations: [] };
  }

  const citations = extractCitations(draft);
  const byId = new Map(returnedFacts.map((f) => [f.id, f]));

  // 3. Every citation must resolve to a fact this turn actually returned.
  //    An unknown id is either a hallucinated reference or a stale one; both
  //    mean the answer is not grounded.
  const resolved = citations.map((id) => byId.get(id)).filter((f) => f !== undefined);
  if (citations.length > 0 && resolved.length === 0) {
    return {
      verdict: "escalate",
      reason: "cited a fact that no tool returned",
      citations,
    };
  }

  const authoritative = resolved.filter((f) => f.tier === "authoritative");
  const authoritativeTopics = new Set(authoritative.map((f) => f.topic));
  const citedTopics = new Set(resolved.map((f) => f.topic));

  // 4. The anti-hallucination check.
  //
  //    Stating a price without an authoritative price fact in hand is the one
  //    failure that costs the business real money, so it is checked directly
  //    against the text rather than trusted to the model.
  if (CURRENCY_CLAIM.test(draft) && !authoritativeTopics.has("price")) {
    return {
      verdict: "escalate",
      reason: "stated a price with no authoritative price fact behind it",
      citations,
    };
  }

  // 5. A commitment topic answered from prose only is still a commitment.
  const commitmentTopicsCited = [...citedTopics].some((t) => COMMITMENT_TOPICS.has(t));
  if (commitmentTopicsCited && authoritative.length === 0) {
    return {
      verdict: "escalate",
      reason: "answered a commitment topic from unverified prose",
      citations,
    };
  }

  if (authoritative.length > 0) {
    return {
      verdict: "answerable",
      reason: `grounded in ${authoritative.length} authoritative fact(s)`,
      citations,
    };
  }

  // 6. Prose only, and the question is not about money, hours or policy.
  if (resolved.length > 0) {
    return {
      verdict: "informational",
      reason: "grounded in background information only",
      citations,
    };
  }

  return {
    verdict: "escalate",
    reason: "no grounding for any claim in the answer",
    citations,
  };
}

/* ------------------------------------------------------------------ */
/* Prompting                                                           */
/* ------------------------------------------------------------------ */

/**
 * The system prompt.
 *
 * Written to be *refused* rather than obeyed. The grounding layer below does
 * not care how well the model followed these instructions -- it re-checks
 * every claim -- but a clear brief still reduces wasted calls and produces
 * better escalations.
 */
export function systemPrompt(businessName: string, currency: string): string {
  return [
    `You are the customer service assistant for ${businessName}.`,
    ``,
    `Rules:`,
    `1. You may only state information that a tool returned to you.`,
    `2. Never estimate, guess, or recall a price, opening hour, location or policy.`,
    `3. After using a fact, cite its id inline like [fact:abc123].`,
    `4. If no tool gives you the answer, call escalate_to_human. Do not improvise.`,
    `5. Be brief. This is a chat channel, and prices are in ${currency}.`,
    ``,
    `You represent a real business. Being wrong about money or policy is worse`,
    `than saying "let me check and have someone come back to you".`,
  ].join("\n");
}
