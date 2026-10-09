import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { contacts, invoices, products, tenants } from "@/db/schema";
import { pick, toTable, type CsvTable } from "@/lib/csv";
import { toMinor } from "@/lib/money";
import { normalisePhone } from "./intents";

/**
 * CSV import.
 *
 * This is the real onboarding bottleneck. A shop has no API, so the agent
 * knows nothing until its products, orders and invoices are in here. Every
 * import is a two-step: validate (`dryRun`) then commit.
 *
 * The validation is deliberately noisy. A shop owner uploading their first
 * spreadsheet will get it wrong, and telling them exactly which row and which
 * column is wrong is the difference between them fixing it and giving up.
 */

export interface RowError {
  /** 1-based row number in the file, including the header. */
  row: number;
  field?: string;
  message: string;
}

export interface ImportResult {
  kind: "products" | "invoices";
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: RowError[];
  /** Things that are not errors but that the owner should know about. */
  warnings: string[];
}

export interface ImportOptions {
  dryRun?: boolean;
}

/* ------------------------------------------------------------------ */
/* Products                                                             */
/* ------------------------------------------------------------------ */

export async function importProducts(
  tenantId: string,
  table: CsvTable,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const db = await getDb();
  const result: ImportResult = {
    kind: "products",
    dryRun: opts.dryRun ?? true,
    total: table.records.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    warnings: [],
  };

  const staged: Array<typeof products.$inferInsert & { row: number }> = [];

  table.records.forEach((record, index) => {
    // +2: 1-based, plus the header row.
    const row = index + 2;

    const sku = pick(record, "sku");
    const name = pick(record, "name");

    if (!sku && !name) {
      result.skipped++;
      return;
    }
    if (!sku) {
      result.errors.push({ row, field: "sku", message: "Missing SKU" });
      return;
    }
    if (!name) {
      result.errors.push({ row, field: "name", message: "Missing product name" });
      return;
    }

    const priceRaw = pick(record, "unit_price");
    let unitPriceMinor = 0;
    if (priceRaw) {
      const cleaned = priceRaw.replace(/[₦,\s]/g, "");
      const parsed = Number(cleaned);
      if (!Number.isFinite(parsed) || parsed < 0) {
        result.errors.push({
          row,
          field: "unit_price",
          message: `"${priceRaw}" is not a valid amount`,
        });
        return;
      }
      unitPriceMinor = toMinor(parsed);
    } else {
      result.warnings.push(`Row ${row}: ${sku} has no price; defaulting to 0.`);
    }

    const stock = parseIntSafe(pick(record, "stock"));
    const reorder = parseIntSafe(pick(record, "reorder_level"));

    staged.push({
      row,
      tenantId,
      sku,
      name,
      unit: pick(record, "unit") || "unit",
      stockQty: stock ?? 0,
      reorderLevel: reorder ?? 0,
      unitPriceMinor,
    });
  });

  if (result.errors.length > 0 || opts.dryRun) {
    if (opts.dryRun) {
      result.created = staged.length;
    }
    return result;
  }

  // Upsert on (tenant, sku). Shops re-export the same catalogue constantly.
  for (const item of staged) {
    const [existing] = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.sku, item.sku)))
      .limit(1);

    if (existing) {
      await db
        .update(products)
        .set({
          name: item.name,
          unit: item.unit,
          stockQty: item.stockQty,
          reorderLevel: item.reorderLevel,
          unitPriceMinor: item.unitPriceMinor,
        })
        .where(eq(products.id, existing.id));
      result.updated++;
    } else {
      await db.insert(products).values(item);
      result.created++;
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Invoices                                                             */
/* ------------------------------------------------------------------ */

export async function importInvoices(
  tenantId: string,
  table: CsvTable,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const db = await getDb();
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);

  const result: ImportResult = {
    kind: "invoices",
    dryRun: opts.dryRun ?? true,
    total: table.records.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    warnings: [],
  };

  // Existing customers, keyed by both raw wa_id and normalised digits, because
  // an export writes "+234 802 000 0002" where we stored "2348020000002".
  const existingContacts = await db
    .select({ id: contacts.id, waId: contacts.waId })
    .from(contacts)
    .where(eq(contacts.tenantId, tenantId));

  const contactLookup = new Map<string, string>();
  for (const contact of existingContacts) {
    contactLookup.set(contact.waId, contact.id);
    contactLookup.set(normalisePhone(contact.waId), contact.id);
  }

  const staged: Array<typeof invoices.$inferInsert & { row: number }> = [];

  table.records.forEach((record, index) => {
    const row = index + 2;

    const number = pick(record, "invoice_number");
    if (!number) {
      result.errors.push({ row, field: "number", message: "Missing invoice number" });
      return;
    }

    const amountRaw = pick(record, "amount").replace(/[₦,\s]/g, "");
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      result.errors.push({
        row,
        field: "amount",
        message: `"${pick(record, "amount")}" is not a valid amount`,
      });
      return;
    }

    const dueOn = parseDate(pick(record, "due_on"));
    if (pick(record, "due_on") && !dueOn) {
      result.errors.push({
        row,
        field: "due_on",
        message: `Could not read "${pick(record, "due_on")}". Use YYYY-MM-DD or DD/MM/YYYY.`,
      });
      return;
    }

    const issuedOn = parseDate(pick(record, "issued_on")) ?? new Date();

    // Resolve the customer. Without a wa_id the invoice is still worth
    // recording, but it can never be chased -- which is the entire point.
    const waIdRaw = pick(record, "wa_id");
    const contactId = waIdRaw
      ? (contactLookup.get(waIdRaw) ??
        contactLookup.get(normalisePhone(waIdRaw)) ??
        null)
      : null;

    if (!contactId) {
      result.warnings.push(
        `Row ${row}: invoice ${number} has no matching WhatsApp number — ` +
          `recorded but cannot be chased automatically.`,
      );
    }

    // Overdue is derived, not trusted from the file.
    const status = dueOn && dueOn.getTime() < Date.now() ? "overdue" : "sent";

    staged.push({
      row,
      tenantId,
      contactId,
      number,
      amountMinor: toMinor(amount),
      currency: tenant?.currency ?? "NGN",
      issuedOn,
      dueOn,
      status,
    });
  });

  if (result.errors.length > 0 || opts.dryRun) {
    if (opts.dryRun) result.created = staged.length;
    return result;
  }

  for (const item of staged) {
    // Skip anything already imported: re-uploading a corrected export must
    // not create duplicate invoices and double the amount chased.
    const [existing] = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(eq(invoices.tenantId, tenantId), eq(invoices.number, item.number)),
      )
      .limit(1);

    if (existing) {
      await db
        .update(invoices)
        .set({
          amountMinor: item.amountMinor,
          dueOn: item.dueOn,
          status: item.status,
          contactId: item.contactId,
        })
        .where(eq(invoices.id, existing.id));
      result.updated++;
    } else {
      await db.insert(invoices).values(item);
      result.created++;
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                             */
/* ------------------------------------------------------------------ */

export async function importCsv(
  tenantId: string,
  csv: string,
  kind: "products" | "invoices" = "products",
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const { parseCsv } = await import("@/lib/csv");
  const rows = parseCsv(csv);
  const table = toTable(rows);

  if (table.records.length === 0) {
    return {
      kind,
      dryRun: opts.dryRun ?? true,
      total: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [{ row: 1, message: "No data rows found. Is the file empty?" }],
      warnings: [],
    };
  }

  return kind === "products"
    ? importProducts(tenantId, table, opts)
    : importInvoices(tenantId, table, opts);
}

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                      */
/* ------------------------------------------------------------------ */

function parseIntSafe(raw: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw.replace(/[,\s]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Accepts what shop owners actually type.
 *
 * Day-first is the default because almost every African business writes
 * `31/12/2026`, and silently reading that as US month/day gives a due date
 * that is eight months wrong.
 */
export function parseDate(raw: string): Date | null {
  if (!raw) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) {
    const date = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw);
  if (dmy) {
    const day = +dmy[1];
    const month = +dmy[2];
    const year = +dmy[3];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return new Date(Date.UTC(year, month - 1, day));
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Total value of what an import would bring in, for the dry-run summary. */
export async function currentTotals(tenantId: string) {
  const db = await getDb();
  const [row] = await db
    .select({
      products: sql<number>`(select count(*)::int from products where tenant_id = ${tenantId})`,
      invoices: sql<number>`(select count(*)::int from invoices where tenant_id = ${tenantId})`,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row ?? { products: 0, invoices: 0 };
}
