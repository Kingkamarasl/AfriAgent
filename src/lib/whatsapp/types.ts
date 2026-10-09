import { z } from "zod";

/**
 * Meta WhatsApp Cloud API webhook payload.
 *
 * Documented permissively on purpose: Meta adds fields without warning, and a
 * strict schema that rejects an unknown key silently drops real customer
 * messages. We parse the parts we need and keep the raw body for the audit log.
 */

const textMessage = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.literal("text"),
  text: z.object({ body: z.string() }),
});

const interactiveMessage = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.literal("interactive"),
  interactive: z
    .object({
      type: z.string(),
      button_reply: z
        .object({ id: z.string(), title: z.string() })
        .optional(),
      list_reply: z
        .object({ id: z.string(), title: z.string(), description: z.string().optional() })
        .optional(),
    })
    .optional(),
});

const unsupportedMessage = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
});

const statusUpdate = z.object({
  id: z.string(),
  status: z.enum(["sent", "delivered", "read", "failed"]),
  timestamp: z.string(),
  recipient_id: z.string(),
  errors: z
    .array(z.object({ code: z.number(), title: z.string(), message: z.string().optional() }))
    .optional(),
});

export const webhookPayloadSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: z.object({
            messaging_product: z.string().optional(),
            metadata: z
              .object({
                display_phone_number: z.string().optional(),
                phone_number_id: z.string().optional(),
              })
              .optional(),
            contacts: z
              .array(
                z.object({
                  profile: z.object({ name: z.string().optional() }).optional(),
                  wa_id: z.string(),
                }),
              )
              .optional(),
            messages: z
              .array(z.union([textMessage, interactiveMessage, unsupportedMessage]))
              .optional(),
            statuses: z.array(statusUpdate).optional(),
            errors: z.array(z.record(z.string(), z.unknown())).optional(),
          }),
        }),
      ),
    }),
  ),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

export interface InboundText {
  waId: string;
  messageId: string;
  body: string;
  timestamp: Date;
  displayName?: string;
  phoneNumberId?: string;
  displayPhoneNumber?: string;
}

export interface DeliveryStatus {
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  waId: string;
  timestamp: Date;
  error?: string;
}

/**
 * Flatten Meta's deeply nested payload into the two streams we actually
 * handle: inbound text, and delivery receipts.
 */
export function normaliseWebhook(
  payload: unknown,
): { inbound: InboundText[]; statuses: DeliveryStatus[] } {
  const parsed = webhookPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Unrecognised webhook payload: ${parsed.error.message}`);
  }

  const inbound: InboundText[] = [];
  const statuses: DeliveryStatus[] = [];

  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const value = change.value;

      for (const message of value.messages ?? []) {
        const body = extractBody(message);
        if (body === null) continue;
        inbound.push({
          waId: message.from,
          messageId: message.id,
          body,
          timestamp: new Date(Number(message.timestamp) * 1000),
          displayName: value.contacts?.find((c) => c.wa_id === message.from)?.profile?.name,
          phoneNumberId: value.metadata?.phone_number_id,
          displayPhoneNumber: value.metadata?.display_phone_number,
        });
      }

      for (const status of value.statuses ?? []) {
        statuses.push({
          providerMessageId: status.id,
          status: status.status,
          waId: status.recipient_id,
          timestamp: new Date(Number(status.timestamp) * 1000),
          error: status.errors?.map((e) => `${e.code}: ${e.title}`).join("; "),
        });
      }
    }
  }

  return { inbound, statuses };
}

function extractBody(message: {
  type: string;
  text?: { body: string };
  interactive?: {
    button_reply?: { title: string };
    list_reply?: { title: string };
  };
}): string | null {
  if (message.type === "text" && message.text) return message.text.body;
  if (message.type === "interactive") {
    const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
    if (reply) return reply.title;
  }
  // Images, voice notes, location pins etc. are not supported in v1. They are
  // dropped here rather than faked, so they never reach a customer as a
  // confusing auto-reply.
  return null;
}
