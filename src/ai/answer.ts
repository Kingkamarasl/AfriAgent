import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { aiUsage, tenants } from "@/db/schema";
import { resolveProvider, type ProviderConfig } from "./index";
import {
  evaluateGrounding,
  systemPrompt,
  type GroundingDecision,
} from "./ground";
import {
  ProviderError,
  type ChatMessage,
  type CompletionResult,
  type Provider,
} from "./provider";
import { runTool, TOOL_SCHEMAS, type ToolFact } from "./tools";

/**
 * The answer pipeline.
 *
 *   provider -> tools -> provider -> grounding -> send or escalate
 *
 * Three things happen here that are not obvious:
 *
 *  - **Budget is checked before spending anything.** A runaway tenant cannot
 *    quietly generate a large bill for the platform.
 *  - **Every failure degrades to escalation.** Provider down, timeout, budget
 *    exhausted -- all become "a human will follow up". Never silence.
 *  - **Cost is recorded but not billed.** The customer is metered per task;
 *    this exists so billable weights can be set from measured numbers later.
 */

/** Tokens per tenant per day before we stop calling the provider. */
const DEFAULT_DAILY_TOKEN_BUDGET = 200_000;

/** Max tool round-trips. Two is enough for every flow we support. */
const MAX_ROUNDS = 2;

export interface AnswerArgs {
  tenantId: string;
  question: string;
  taskId?: string;
  /** Recent turns, oldest first, for context. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface AnswerOutcome {
  verdict: "answerable" | "informational" | "escalate";
  /** Customer-facing text. Empty when escalating. */
  draft: string;
  reason: string;
  citations: string[];
  toolsUsed: string[];
  provider: string;
  model: string;
  totalTokens: number;
  costMicros: number;
}

export function dayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Budget                                                              */
/* ------------------------------------------------------------------ */

export async function tokensUsedToday(tenantId: string, day = dayKey()): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${aiUsage.totalTokens}), 0)::int`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.tenantId, tenantId), eq(aiUsage.day, day)));

  return row?.total ?? 0;
}

export interface BudgetStatus {
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
}

export async function budgetStatus(tenantId: string): Promise<BudgetStatus> {
  const limit = Number(
    process.env.AI_DAILY_TOKEN_BUDGET ?? DEFAULT_DAILY_TOKEN_BUDGET,
  );
  const used = await tokensUsedToday(tenantId);
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    exhausted: used >= limit,
  };
}

/* ------------------------------------------------------------------ */
/* Cost model                                                          */
/* ------------------------------------------------------------------ */

/**
 * Micro-dollars per million tokens, per model.
 *
 * Approximate and intentionally conservative -- this drives a budget guard
 * and a calibration exercise, not an invoice. Replace with a live price list
 * before it is used for anything that affects money.
 */
const PRICE_PER_MILLION_MICROS: Record<string, { prompt: number; completion: number }> = {
  "nvidia/llama-3.1-nemotron-70b-instruct": { prompt: 400_000, completion: 1_200_000 },
  "meta/llama-3.3-70b-instruct": { prompt: 400_000, completion: 1_200_000 },
  "qwen/qwen3-235b-a22b": { prompt: 200_000, completion: 600_000 },
};

const FALLBACK_PRICE = { prompt: 400_000, completion: 1_200_000 };

export function estimateCostMicros(
  model: string,
  usage: { promptTokens: number; completionTokens: number },
): number {
  const price = PRICE_PER_MILLION_MICROS[model] ?? FALLBACK_PRICE;
  return Math.round(
    (usage.promptTokens / 1_000_000) * price.prompt +
      (usage.completionTokens / 1_000_000) * price.completion,
  );
}

async function recordUsage(args: {
  tenantId: string;
  taskId?: string;
  config: ProviderConfig;
  result: CompletionResult;
  round: number;
  outcome: string;
}) {
  const db = await getDb();
  const costMicros = estimateCostMicros(args.result.model, args.result.usage);

  await db.insert(aiUsage).values({
    tenantId: args.tenantId,
    taskId: args.taskId,
    provider: args.config.provider,
    model: args.result.model,
    promptTokens: args.result.usage.promptTokens,
    completionTokens: args.result.usage.completionTokens,
    totalTokens: args.result.usage.totalTokens,
    costMicros,
    round: args.round,
    outcome: args.outcome,
    day: dayKey(),
  });

  return costMicros;
}

/* ------------------------------------------------------------------ */
/* Answer                                                              */
/* ------------------------------------------------------------------ */

export async function answerCustomerQuestion(
  args: AnswerArgs,
  providerOverride?: Provider,
): Promise<AnswerOutcome> {
  const { provider, config } = providerOverride
    ? {
        provider: providerOverride,
        config: {
          provider: providerOverride.name as ProviderConfig["provider"],
          model: "override",
          degraded: false,
        },
      }
    : resolveProvider();

  const base: AnswerOutcome = {
    verdict: "escalate",
    draft: "",
    reason: "",
    citations: [],
    toolsUsed: [],
    provider: config.provider,
    model: config.model,
    totalTokens: 0,
    costMicros: 0,
  };

  // Budget first: never spend what we have already promised not to.
  const budget = await budgetStatus(args.tenantId);
  if (budget.exhausted) {
    return {
      ...base,
      reason: `ai budget exhausted (${budget.used}/${budget.limit} tokens today)`,
    };
  }

  const db = await getDb();
  const [tenant] = await db
    .select({ name: tenants.name, currency: tenants.currency })
    .from(tenants)
    .where(eq(tenants.id, args.tenantId))
    .limit(1);

  if (!tenant) return { ...base, reason: "unknown tenant" };

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(tenant.name, tenant.currency) },
    ...(args.history ?? []).map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: args.question },
  ];

  const returnedFacts = new Map<string, ToolFact>();
  const toolsUsed: string[] = [];
  let escalateToolReason: string | undefined;
  let escalatedByModel: { reason: string } | undefined;
  let totalTokens = 0;
  let totalCost = 0;
  let result: CompletionResult | undefined;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      result = await provider.complete({ messages, tools: TOOL_SCHEMAS });

      totalTokens += result.usage.totalTokens;
      totalCost += await recordUsage({
        tenantId: args.tenantId,
        taskId: args.taskId,
        config,
        result,
        round,
        outcome: "ok",
      });

      if (result.toolCalls.length === 0) break;

      messages.push({
        role: "assistant",
        content: result.content,
        toolCalls: result.toolCalls,
      });

      for (const call of result.toolCalls) {
        toolsUsed.push(call.name);

        // tenantId comes from the verified session, never from the model.
        const outcome = await runTool(call.name, { tenantId: args.tenantId }, call.arguments);

        if (outcome.ok) {
          for (const fact of outcome.result.facts) {
            returnedFacts.set(fact.id, fact);
          }
          if (call.name === "escalate_to_human") {
            escalateToolReason = String(outcome.result.data?.reason ?? "model escalated");
          }
        }

        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: outcome.ok
            ? JSON.stringify(outcome.result)
            : JSON.stringify({ error: outcome.error }),
        });
      }
    }
  } catch (error) {
    const reason =
      error instanceof ProviderError
        ? `provider ${error.kind}: ${error.message}`
        : error instanceof Error
          ? error.message
          : "unknown error";

    if (result) {
      await recordUsage({
        tenantId: args.tenantId,
        taskId: args.taskId,
        config,
        result,
        round: MAX_ROUNDS,
        outcome: "provider_error",
      });
    }

    // Degrade, do not crash.
    return {
      ...base,
      reason,
      toolsUsed,
      totalTokens,
      costMicros: totalCost,
    };
  }

  const decision: GroundingDecision = evaluateGrounding({
    draft: result?.content ?? "",
    question: args.question,
    returnedFacts: [...returnedFacts.values()],
    escalateToolReason,
    escalatedByModel,
  });

  const deliverable = decision.verdict !== "escalate";

  await db
    .update(aiUsage)
    .set({ outcome: deliverable ? "ok" : "ungrounded" })
    .where(
      and(
        eq(aiUsage.tenantId, args.tenantId),
        gte(aiUsage.createdAt, new Date(Date.now() - 5_000)),
      ),
    );

  return {
    verdict: decision.verdict,
    draft: deliverable ? (result?.content ?? "") : "",
    reason: decision.reason,
    citations: decision.citations,
    toolsUsed,
    provider: config.provider,
    model: config.model,
    totalTokens,
    costMicros: totalCost,
  };
}

/** Customer-facing text when the assistant could not answer safely. */
export function escalationMessage(businessName: string): string {
  return (
    `Thanks for your message about ${businessName}. ` +
    `I've asked a member of the team to get back to you directly.`
  );
}
