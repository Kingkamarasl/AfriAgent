/**
 * Outbound message templates.
 *
 * Why this file exists: outside Meta's 24-hour customer service window we are
 * legally required to send a pre-approved template. That covers almost
 * everything valuable this product does -- daily summaries, invoice chases,
 * stock alerts -- because those go out on a schedule, not in reply to a
 * customer.
 *
 * Every outbound path routes through here, so the 24-hour rule is enforced by
 * construction rather than remembered.
 */

export interface TemplateDefinition {
  /** Must match the name approved in Meta's template manager. */
  name: string;
  /** Meta utility category -- drives Meta's own billing. */
  category: "UTILITY" | "MARKETING";
  /** Ordered `{{1}}`, `{{2}}` ... placeholders. */
  placeholders: string[];
  /** Human-readable preview, and what we store on the task for review. */
  preview: (...values: string[]) => string;
}

export const TEMPLATES = {
  invoice_reminder: {
    name: "invoice_reminder_v1",
    category: "UTILITY",
    placeholders: ["customer_name", "invoice_number", "amount", "payment_link"],
    preview: (name, number, amount, link) =>
      `Hi ${name}, a friendly reminder that invoice ${number} for ${amount} is still outstanding. You can settle it here: ${link}`,
  },
  daily_summary: {
    name: "daily_summary_v1",
    category: "UTILITY",
    placeholders: ["shop_name", "summary_body"],
    preview: (shop, body) => `${shop} — daily summary\n\n${body}`,
  },
  low_stock_alert: {
    name: "low_stock_alert_v1",
    category: "UTILITY",
    placeholders: ["shop_name", "stock_body"],
    preview: (shop, body) => `${shop} — running low\n\n${body}`,
  },
  handoff: {
    name: "handoff_v1",
    category: "UTILITY",
    placeholders: ["customer_name"],
    preview: (name) =>
      `Hi ${name}, thanks for reaching out. I've asked a member of the team to follow up with you directly.`,
  },
} as const satisfies Record<string, TemplateDefinition>;

export type TemplateName = keyof typeof TEMPLATES;

export type TemplateSend =
  | { template: "invoice_reminder"; values: [string, string, string, string] }
  | { template: "daily_summary"; values: [string, string] }
  | { template: "low_stock_alert"; values: [string, string] }
  | { template: "handoff"; values: [string] };

export function buildTemplatePreview(send: TemplateSend): string {
  // Annotated as the interface, not the `as const` literal type: each entry's
  // `preview` has a fixed arity, and a union of those cannot accept a spread.
  const def: TemplateDefinition = TEMPLATES[send.template];
  return def.preview(...(send.values as unknown as string[]));
}

/** Meta expects positional body parameters in declaration order. */
export function buildTemplatePayload(to: string, send: TemplateSend) {
  const def = TEMPLATES[send.template];
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: def.name,
      language: { code: "en" },
      components: [
        {
          type: "body",
          parameters: send.values.map((text) => ({ type: "text", text })),
        },
      ],
    },
  };
}
