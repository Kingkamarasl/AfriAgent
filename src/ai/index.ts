import { NvidiaProvider } from "./nvidia";
import { ScriptedProvider } from "./scripted";
import type { Provider } from "./provider";

/**
 * Provider selection.
 *
 * One adapter today. The seam is real -- swapping providers is a config
 * change -- but it is not a general registry, because a registry with one
 * entry is an abstraction without a test.
 */

export type ProviderName = "nvidia" | "scripted";

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  /** Set when no provider is configured and the scripted fallback is in use. */
  degraded: boolean;
}

export const DEFAULT_MODEL = "nvidia/llama-3.1-nemotron-70b-instruct";

export function resolveProvider(): { provider: Provider; config: ProviderConfig } {
  const name = (process.env.AI_PROVIDER ?? "nvidia").toLowerCase();
  const model = process.env.AI_MODEL ?? DEFAULT_MODEL;

  if (name === "scripted") {
    return {
      provider: new ScriptedProvider([{ content: "" }]),
      config: { provider: "scripted", model: "scripted", degraded: true },
    };
  }

  const apiKey = process.env.NVIDIA_API_KEY;

  if (!apiKey) {
    // Degrade to deterministic behaviour rather than to an error. A customer
    // gets a queued "someone will be with you", not a 500.
    console.warn(
      "[ai] NVIDIA_API_KEY is not set. The assistant will not answer " +
        "questions until it is configured; it will escalate instead.\n" +
        "[ai] Set NVIDIA_API_KEY, or AI_PROVIDER=scripted for local work.",
    );
    return {
      provider: new ScriptedProvider([
        {
          error: {
            message: "No AI provider configured",
            kind: "unauthorized",
          },
        },
      ]),
      config: { provider: "scripted", model: "scripted", degraded: true },
    };
  }

  return {
    provider: new NvidiaProvider({
      apiKey,
      model,
      baseUrl: process.env.AI_BASE_URL,
      timeoutMs: process.env.AI_TIMEOUT_MS
        ? Number(process.env.AI_TIMEOUT_MS)
        : undefined,
    }),
    config: { provider: "nvidia", model, degraded: false },
  };
}
