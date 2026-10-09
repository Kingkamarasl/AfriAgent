import { nanoid } from "nanoid";
import { z } from "zod";
import { handleInboundMessage } from "@/domain/pipeline";

export const runtime = "nodejs";

/**
 * Local WhatsApp simulator.
 *
 * Lets the entire flow be exercised before Meta credentials exist:
 *
 *   curl -X POST http://localhost:3000/api/simulate/inbound \
 *     -H "content-type: application/json" \
 *     -d '{"from":"2348010000001","text":"Show me today\u2019s sales"}'
 *
 * The seeded owner's wa_id is 2348010000001. Any other number is treated as
 * a customer of the shop, which is how you exercise the support flow.
 */

const inboundSchema = z.object({
  from: z.string().min(4).optional(),
  text: z.string().min(1).max(4096),
  name: z.string().optional(),
  /** Set only if you have seeded more than one tenant. */
  tenantSlug: z.string().optional(),
});

export async function POST(request: Request) {
  const parsed = inboundSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const body = parsed.data;
  const outcome = await handleInboundMessage({
    waId: body.from ?? "2348010000001",
    body: body.text,
    messageId: `wamid.SIM.${nanoid()}`,
    timestamp: new Date(),
    displayName: body.name,
    tenantSlug: body.tenantSlug,
  });

  if (!outcome.tenantId) {
    return Response.json(
      {
        error:
          "No tenant found. Run `npm run db:seed` first, or pass tenantSlug.",
      },
      { status: 404 },
    );
  }

  return Response.json({
    ok: true,
    senderRole: outcome.role,
    tasksCreated: outcome.taskIds.length,
    taskIds: outcome.taskIds,
    insideServiceWindow: outcome.insideServiceWindow,
  });
}

/** Suggested messages, so the playground has something to click. */
export async function GET() {
  return Response.json({
    ownerWaId: "2348010000001",
    customerWaId: "2348020000002",
    samples: [
      { label: "Multi-intent owner message", from: "2348010000001", text: "Show me today's sales, remind customers with overdue invoices, and tell me which products are running low" },
      { label: "Sales report only", from: "2348010000001", text: "How much did I make today?" },
      { label: "Customer asks about stock", from: "2348020000002", text: "Do you have Peak milk powder in stock?" },
      { label: "Customer asks for a human", from: "2348030000003", text: "I want to speak to someone about my invoice" },
    ],
  });
}
