import { ProviderError, type CompletionResult, type Provider, type ToolCall } from "./provider";

/**
 * A scripted provider.
 *
 * Exists so the safety rules -- grounding, escalation, budget limits, tool
 * isolation -- are provable in CI with no API key and no network. Without it
 * those rules would only ever be tested against a live model, which is both
 * flaky and unable to test the cases that matter most.
 *
 * In development it also acts as the fallback when no provider is configured,
 * so the product degrades to deterministic behaviour rather than to an error.
 */

export interface ScriptedRound {
  content?: string;
  toolCalls?: ToolCall[];
  usage?: { promptTokens?: number; completionTokens?: number };
  /** Throw instead of replying, to exercise the failure path. */
  error?: { message: string; kind?: ConstructorParameters<typeof ProviderError>[1] };
}

export class ScriptedProvider implements Provider {
  readonly name = "scripted";
  private callCount = 0;

  constructor(private readonly script: ScriptedRound[]) {}

  async health() {
    return { ok: true };
  }

  async complete(): Promise<CompletionResult> {
    const round = this.script[this.callCount] ?? { content: "" };
    this.callCount++;

    if (round.error) {
      throw new ProviderError(
        round.error.message,
        round.error.kind ?? "unavailable",
      );
    }

    const promptTokens = round.usage?.promptTokens ?? 120;
    const completionTokens = round.usage?.completionTokens ?? 40;

    return {
      content: round.content ?? "",
      toolCalls: round.toolCalls ?? [],
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      model: "scripted",
    };
  }

  get calls(): number {
    return this.callCount;
  }
}

/**
 * Deliberately confident and wrong.
 *
 * Used to prove the grounding layer catches a plausible hallucination: this
 * provider invents a price for a product the business has no fact for, and
 * the pipeline must escalate rather than send it to a customer.
 */
export function hallucinatingPriceProvider(price = "₦2,000"): ScriptedProvider {
  return new ScriptedProvider([
    { content: `Yes, that is ${price} for the item.` },
  ]);
}
