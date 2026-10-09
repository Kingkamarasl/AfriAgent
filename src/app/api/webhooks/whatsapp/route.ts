import { applyDeliveryStatus, handleInboundMessage } from "@/domain/pipeline";
import { verifyWebhookSignature } from "@/lib/whatsapp/client";
import { normaliseWebhook } from "@/lib/whatsapp/types";

export const runtime = "nodejs";

/**
 * Meta WhatsApp Cloud API webhook.
 *
 * Configure this URL in the WhatsApp Manager -> Configuration -> Webhooks
 * panel, subscribing to the `messages` field.
 *
 *   GET  -> Meta's one-time verification handshake
 *   POST -> inbound customer/owner messages and delivery receipts
 */

/* ------------------------------------------------------------------ */
/* Verification                                                         */
/* ------------------------------------------------------------------ */

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (mode === "subscribe" && token && token === expected) {
    console.log("[whatsapp] webhook verified");
    return new Response(challenge ?? "", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  // Never echo the expected token back in the body.
  return new Response("Forbidden", { status: 403 });
}

/* ------------------------------------------------------------------ */
/* Events                                                               */
/* ------------------------------------------------------------------ */

export async function POST(request: Request) {
  const rawBody = await request.text();

  // Signature check must run against the raw bytes, before JSON.parse.
  const signature = request.headers.get("x-hub-signature-256");
  if (!(await verifyWebhookSignature(rawBody, signature))) {
    console.warn("[whatsapp] rejected webhook with bad signature");
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Malformed JSON", { status: 400 });
  }

  if ((payload as { object?: string })?.object !== "whatsapp_business_account") {
    // Not ours. 200 so Meta stops retrying something we will never handle.
    return Response.json({ ok: true, ignored: true });
  }

  const { inbound, statuses } = normaliseWebhook(payload);

  // Delivery receipts first: cheap, and they keep the message view accurate.
  for (const status of statuses) {
    await applyDeliveryStatus(status);
  }

  const handled: string[] = [];
  for (const message of inbound) {
    try {
      const outcome = await handleInboundMessage({
        waId: message.waId,
        body: message.body,
        messageId: message.messageId,
        timestamp: message.timestamp,
        displayName: message.displayName,
        phoneNumberId: message.phoneNumberId,
      });
      handled.push(...outcome.taskIds);
    } catch (error) {
      // Log and continue: one bad message must not stall the whole batch,
      // and the 200 keeps Meta from redelivering everything.
      console.error(
        `[whatsapp] failed to handle ${message.messageId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Acknowledge fast. Anything slow belongs in a queue, not in the webhook.
  return Response.json({ ok: true, tasks: handled });
}
