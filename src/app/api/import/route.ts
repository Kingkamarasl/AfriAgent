import { requireManagerActor } from "@/app/actions";
import { currentTotals, importCsv } from "@/domain/import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * CSV import.
 *
 *   POST /api/import?kind=products            -> validate only (dry run)
 *   POST /api/import?kind=products&commit=1   -> write
 *
 * Dry run is the default on purpose. Importing is the highest-risk write in
 * the product -- a bad file would poison every report the agent produces --
 * so nothing lands without an explicit `commit=1`.
 *
 * Body is the raw CSV text, `text/csv`:
 *
 *   curl -X POST "http://localhost:3000/api/import?kind=products" \
 *     -H "content-type: text/csv" --data-binary @catalogue.csv
 */
export async function POST(request: Request) {
  let tenantId: string;
  try {
    ({ tenantId } = await requireManagerActor());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Not authorised" },
      { status: 403 },
    );
  }

  const url = new URL(request.url);
  const kindParam = url.searchParams.get("kind") ?? "products";
  const commit = url.searchParams.get("commit") === "1";

  if (kindParam !== "products" && kindParam !== "invoices") {
    return Response.json(
      { error: `Unknown kind "${kindParam}". Use "products" or "invoices".` },
      { status: 400 },
    );
  }

  const csv = await request.text();
  if (!csv.trim()) {
    return Response.json({ error: "Empty body" }, { status: 400 });
  }

  const result = await importCsv(tenantId, csv, kindParam, { dryRun: !commit });
  const totals = await currentTotals(tenantId);

  return Response.json({
    ...result,
    committed: commit,
    current: totals,
    // Refuse to commit a file with structural errors. Warnings (a missing
    // price, an invoice with no WhatsApp number) are allowed through --
    // those are the owner's judgement calls, not blockers.
    blocked: result.errors.length > 0 && commit,
  });
}
