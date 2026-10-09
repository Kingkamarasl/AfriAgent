import { buildTemplatePayload, type TemplateSend } from "./templates";

/**
 * Outbound delivery.
 *
 * Two transports behind one interface:
 *
 *   Cloud API  - real Meta Graph API calls. Requires WHATSAPP_ACCESS_TOKEN and
 *                WHATSAPP_PHONE_NUMBER_ID, which you only get once a WABA
 *                exists.
 *   Simulator  - logs the exact payload that *would* have been sent and
 *                returns a synthetic wamid. This is how the whole flow is
 *                testable before Meta verification finishes, and it is also
 *                the safety net that stops a dev mistake from texting a real
 *                customer.
 */

export interface SendResult {
  providerMessageId: string | null;
  deliveredVia: "cloud_api" | "simulated";
}

export interface OutboundMessage {
  to: string;
  /** Free-form text. Only legal inside the 24h customer service window. */
  text?: string;
  /** Approved template. Legal at any time. */
  template?: TemplateSend;
}

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0";

export function isCloudApiConfigured(): boolean {
  return Boolean(
    process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID,
  );
}

function isSimulated(to: string): boolean {
  // 0000000000 is the reserved test number used by the local simulator.
  return to === "0000000000" || !isCloudApiConfigured();
}

/* ------------------------------------------------------------------ */
/* Window enforcement                                                   */
/* ------------------------------------------------------------------ */

export const CS_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isInsideServiceWindow(windowExpiresAt: Date | null): boolean {
  return windowExpiresAt !== null && windowExpiresAt.getTime() > Date.now();
}

export class OutsideServiceWindowError extends Error {
  constructor(readonly to: string) {
    super(
      `Refusing to send free-form text to ${to}: outside the 24h customer ` +
        `service window. An approved template is required.`,
    );
    this.name = "OutsideServiceWindowError";
  }
}

/* ------------------------------------------------------------------ */
/* Sending                                                              */
/* ------------------------------------------------------------------ */

export async function sendMessage(
  message: OutboundMessage,
  opts: { insideServiceWindow: boolean; dryRun?: boolean },
): Promise<SendResult> {
  if (!message.template && !opts.insideServiceWindow) {
    // Hard stop. This is the rule Meta enforces with a 131009 error, but we
    // never want to learn that from a production incident.
    throw new OutsideServiceWindowError(message.to);
  }

  const payload = message.template
    ? buildTemplatePayload(message.to, message.template)
    : {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: message.to,
        type: "text",
        text: { preview_url: false, body: message.text ?? "" },
      };

  if (opts.dryRun || isSimulated(message.to)) {
    return simulateSend(payload);
  }

  return cloudApiSend(payload);
}

async function cloudApiSend(payload: Record<string, unknown>): Promise<SendResult> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!;
  const token = process.env.WHATSAPP_ACCESS_TOKEN!;

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  const body = (await res.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string }>;
    error?: { message?: string; code?: number; error_subcode?: number };
  };

  if (!res.ok || body.error) {
    const detail = body.error
      ? `${body.error.code}/${body.error.error_subcode ?? "-"}: ${body.error.message}`
      : `HTTP ${res.status}`;
    throw new Error(`WhatsApp Cloud API rejected the message -- ${detail}`);
  }

  return {
    providerMessageId: body.messages?.[0]?.id ?? null,
    deliveredVia: "cloud_api",
  };
}

/**
 * No network call. Prints the payload so the exact outbound message is always
 * inspectable during development, and returns a well-formed synthetic id so
 * downstream status handling is exercised identically.
 */
async function simulateSend(payload: Record<string, unknown>): Promise<SendResult> {
  const to = String(payload.to);
  const providerMessageId = `wamid.SIMULATED.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  // Plain ASCII on purpose: box-drawing characters mangle on the Windows
  // console, and this output is read during development more than anywhere else.
  console.log(
    [
      "",
      "  -- WhatsApp (simulated) --------------------------",
      `  to:   ${to}`,
      `  type: ${payload.type}`,
      payload.type === "template"
        ? `  tpl:  ${(payload.template as { name: string }).name}`
        : `  text: ${(payload.text as { body: string } | undefined)?.body}`,
      `  id:   ${providerMessageId}`,
      "  -------------------------------------------------",
      "",
    ].join("\n"),
  );

  return { providerMessageId, deliveredVia: "simulated" };
}

/**
 * Verify the webhook really came from Meta.
 *
 * Without this, anyone who learns your endpoint URL can inject fake customer
 * messages and drive your agent. Set WHATSAPP_APP_SECRET in production.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true; // Not configured -- dev convenience only.

  if (!signatureHeader) return false;

  const expected = await hmacSha256(secret, rawBody);
  const provided = signatureHeader.replace(/^sha256=/, "");
  if (provided.length !== expected.length) return false;

  // Constant-time compare.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
