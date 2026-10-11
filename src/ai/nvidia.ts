import {
  ProviderError,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type TokenUsage,
  type ToolCall,
} from "./provider";

/**
 * NVIDIA NIM adapter.
 *
 * NIM is OpenAI-compatible (vLLM under the hood) and supports native tool
 * calling, so this is a thin translation rather than a translation layer of
 * consequence. That is deliberate: a provider that needed a custom protocol
 * would not belong behind this interface.
 *
 * Works against both the hosted endpoint (build.nvidia.com / integrate.*) and
 * a self-hosted NIM container -- only the base URL differs.
 */

const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_TIMEOUT_MS = 20_000;

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

export interface NvidiaOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class NvidiaProvider implements Provider {
  readonly name = "nvidia";

  constructor(private readonly options: NvidiaOptions) {}

  private get baseUrl(): string {
    return (this.options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        return { ok: false, detail: `HTTP ${res.status}` };
      }
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const available = body.data?.map((m) => m.id) ?? [];
      return {
        ok: available.includes(this.options.model),
        detail: available.includes(this.options.model)
          ? undefined
          : `model "${this.options.model}" not in /models; try one of: ${available.slice(0, 8).join(", ")}`,
      };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "unreachable" };
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body = {
      model: this.options.model,
      messages: req.messages.map(toWireMessage),
      // Greedy by default. This product cannot afford creative answers to
      // questions about prices and policies.
      temperature: req.temperature ?? 0.1,
      max_tokens: req.maxTokens ?? 400,
      ...(req.tools?.length ? { tools: req.tools, tool_choice: "auto" } : {}),
    };

    const timeout = AbortSignal.timeout(this.timeoutMs);
    // Honour an upstream cancellation as well as our own timeout.
    const signal = req.signal
      ? AbortSignal.any([req.signal, timeout])
      : timeout;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (timeout.aborted) {
        throw new ProviderError(
          `NVIDIA request timed out after ${this.timeoutMs}ms`,
          "timeout",
        );
      }
      throw new ProviderError(
        `NVIDIA request failed: ${error instanceof Error ? error.message : "network error"}`,
        "unavailable",
      );
    }

    const text = await res.text();
    let json: ChatCompletionResponse;
    try {
      json = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      throw new ProviderError(
        `NVIDIA returned non-JSON (HTTP ${res.status})`,
        "bad_response",
      );
    }

    if (!res.ok) {
      throw new ProviderError(
        `NVIDIA HTTP ${res.status}: ${json.error?.message ?? text.slice(0, 200)}`,
        res.status === 401 || res.status === 403
          ? "unauthorized"
          : res.status === 429
            ? "rate_limited"
            : "unknown",
        res.status === 429 || res.status >= 500,
      );
    }

    const choice = json.choices?.[0];
    if (!choice?.message) {
      throw new ProviderError("NVIDIA response had no choices", "bad_response");
    }

    return {
      content: (choice.message.content ?? "").trim(),
      toolCalls: parseToolCalls(choice.message.tool_calls),
      usage: readUsage(json.usage),
      model: this.options.model,
    };
  }
}

function toWireMessage(message: ChatMessage) {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }

  return { role: message.role, content: message.content };
}

/**
 * Arguments arrive as a JSON string and must be parsed defensively: a
 * malformed tool call is a normal occurrence with an open model, not an
 * exception. Returning an empty object lets the tool's own validation reject
 * it with a message the model can recover from.
 */
type RawToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

function parseToolCalls(raw: RawToolCall[] | undefined): ToolCall[] {
  if (!raw?.length) return [];

  return raw.flatMap((call, index) => {
    const name = call.function?.name;
    if (!name) return [];

    let args: Record<string, unknown> = {};
    const rawArgs = call.function?.arguments;
    if (rawArgs) {
      try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // Leave empty; the tool will reject it with a clear message.
      }
    }

    return [
      {
        id: call.id ?? `call_${index}`,
        name,
        arguments: args,
      },
    ];
  });
}

function readUsage(usage: ChatCompletionResponse["usage"]): TokenUsage {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    // Some deployments omit total_tokens; never let it read as zero, or the
    // budget guard silently stops working.
    totalTokens: usage?.total_tokens ?? promptTokens + completionTokens,
  };
}
