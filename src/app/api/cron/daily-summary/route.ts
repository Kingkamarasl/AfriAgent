import { runDailySummaries } from "@/domain/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daily summary cron.
 *
 * Wire it to whatever scheduler you use. Vercel Cron:
 *
 *   { "crons": [{ "path": "/api/cron/daily-summary", "schedule": "0 7 * * *" }] }
 *
 * or from any machine:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://your-app/api/cron/daily-summary
 *
 * Timing is in the tenant's own timezone -- 07:00 UTC is 08:00 in Lagos and
 * 09:00 in Nairobi, and a summary that lands at 5am local is not a habit.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    // Fail closed. An unauthenticated endpoint here means anyone on the
    // internet can trigger messages to real customers' phones.
    return Response.json(
      { error: "CRON_SECRET is not configured" },
      { status: 503 },
    );
  }

  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== secret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = await runDailySummaries();

  return Response.json({
    ok: true,
    ran: results.filter((r) => r.status === "ran").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  });
}
