import { NvidiaProvider } from "./nvidia";
import { ScriptedProvider } from "./scripted";
import type { Provider } from "./provider";
import { getPlatformSecret, getPlatformSetting } from "@/domain/platform-settings";

/**
 * Provider selection.
 *
 * One adapter today. The seam is real -- swapping providers is a config
 * change -- but it is not a general registry, because a registry with one
 * entry is an abstraction without a test.
 *
 * Credentials come from platform settings, not the environment. The env var is
 * a bootstrap path only: a fresh deployment works before anyone has visited the
 * admin page, and once a key is saved it wins, so an admin can rotate it without
 * a redeploy. That ordering is the whole reason this is in a database.
 */

export type ProviderName = "nvidia" | "scripted";

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  /** Set when no provider is configured and the scripted fallback is in use. */
  degraded: boolean;
}

export const DEFAULT_MODEL = "nvidia/llama-3.1-nemotron-70b-instruct";

/**
 * Settings keys, kept together so the admin surface and the reader cannot drift.
 */
export const AI_SETTING_MODEL = "ai_model";
export const AI_SETTING_BASE_URL = "ai_base_url";
export const AI_SETTING_THINKING_PARAM = "ai_thinking_param";
export const AI_SECRET_NVIDIA_KEY = "nvidia_api_key";

/**
 * Asynchronous because credentials come from the database.
 *
 * The read is cached for 30s (see `domain/platform-settings`), so this does not
 * add a query to every inbound message.
 */
export async function resolveProvider(): Promise<{
  provider: Provider;
  config: ProviderConfig;
}> {
  const name = (process.env.AI_PROVIDER ?? "nvidia").toLowerCase();

  if (name === "scripted") {
    return {
      provider: new ScriptedProvider([{ content: "" }]),
      config: { provider: "scripted", model: "scripted", degraded: true },
    };
  }

  // Settings win over env; env is the bootstrap fallback.
  const [storedKey, model, baseUrl, thinkingParam] = await Promise.all([
    getPlatformSecret(AI_SECRET_NVIDIA_KEY).catch(() => null),
    getPlatformSetting(AI_SETTING_MODEL, process.env.AI_MODEL ?? DEFAULT_MODEL).catch(
      () => process.env.AI_MODEL ?? DEFAULT_MODEL,
    ),
    getPlatformSetting(AI_SETTING_BASE_URL, process.env.AI_BASE_URL ?? "").catch(
      () => process.env.AI_BASE_URL ?? "",
    ),
    getPlatformSetting(
      AI_SETTING_THINKING_PARAM,
      process.env.AI_THINKING_PARAM ?? "",
    ).catch(() => process.env.AI_THINKING_PARAM ?? ""),
  ]);

  const apiKey = storedKey ?? process.env.NVIDIA_API_KEY;

  if (!apiKey) {
    // Degrade to deterministic behaviour rather than to an error. A customer
    // gets a queued "someone will be with you", not a 500.
    console.warn(
      "[ai] No NVIDIA API key configured. The assistant will not answer " +
        "questions until one is set; it will escalate instead.\n" +
        "[ai] Set it at /admin/platform, or set NVIDIA_API_KEY to bootstrap. " +
        "For local work use AI_PROVIDER=scripted.",
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
      baseUrl: baseUrl || undefined,
      timeoutMs: process.env.AI_TIMEOUT_MS
        ? Number(process.env.AI_TIMEOUT_MS)
        : undefined,
      // Overridable because the kwarg name varies by model family. Run
      // `npm run ai:check` to find out which one your model wants.
      thinkingParam: thinkingParam || undefined,
    }),
    config: { provider: "nvidia", model, degraded: false },
  };
}