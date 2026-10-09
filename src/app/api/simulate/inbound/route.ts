import { nanoid } from "nanoid";
import { z } from "zod";
import { handleInboundMessage } from "@/domain/pipeline";
import { getCurrentActor } from "@/lib/auth/session";

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
 * Requires a signed-in development account. The tenant is derived from that
 * session; callers cannot choose another tenant in the request body.
 */

const inboundSchema = z.object({
  from: z.string().min(4).optional(),
  text: z.string().min(1).max(4096),
  name: z.string().optional(),
});

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return Response.json({ error: "Simulator is disabled in production" }, { status: 404 });
  }
  const actor = await getCurrentActor();
  if (!actor) return Response.json({ error: "Sign in required" }, { status: 401 });
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
    // Tenant is resolved from the authenticated session, never from request JSON.
    tenantId: actor.tenantId,
  });

  if (!outcome.tenantId) {
    return Response.json(
      {
        error: "The authenticated business workspace could not be resolved.",
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
  if (process.env.NODE_ENV === "production") {
    return Response.json({ error: "Simulator is disabled in production" }, { status: 404 });
  }
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
