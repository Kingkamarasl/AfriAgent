/**
 * The provider seam.
 *
 * Deliberately shaped around **tool calling**, not around chat completion.
 * That is the only part of a model API this product actually depends on, so
 * it is the part worth abstracting. Everything else -- temperature, streaming,
 * embeddings -- is not in here, and should not be added until something
 * needs it.
 *
 * One adapter exists today (NVIDIA NIM). The seam exists so a second one can
 * be added without touching the caller, not so two are maintained before the
 * interface has been tested by real traffic.
 */

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Already parsed; providers that emit JSON strings are parsed in the adapter. */
  arguments: Record<string, unknown>;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: MessageRole;
  content: string;
  /** Required when role is "tool": which call this result answers. */
  toolCallId?: string;
  /** Present on assistant messages that requested tools. */
  toolCalls?: ToolCall[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  model: string;
}

export interface Provider {
  readonly name: string;
  /** Cheap reachability probe used by Platform Admin diagnostics. */
  health(): Promise<{ ok: boolean; detail?: string }>;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/**
 * Raised for anything the caller is expected to handle rather than crash on:
 * network failure, auth failure, rate limit, timeout.
 *
 * The answer pipeline turns every one of these into "escalate to a human",
 * because an assistant that stops answering looks broken, and a customer is
 * better served by a queued reply than by silence.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "unavailable"
      | "unauthorized"
      | "rate_limited"
      | "timeout"
      | "bad_response"
      | "unknown",
    readonly retryable = true,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Thrown when the provider returns something we cannot safely use. */
export class GroundingError extends Error {
  constructor(message: string, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = "GroundingError";
  }
}
