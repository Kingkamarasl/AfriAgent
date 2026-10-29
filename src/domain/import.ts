import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  contacts,
  invoices,
  orderItems,
  orders,
  products,
  tenants,
} from "@/db/schema";
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
 *
 * Orders matter more than they look: `sales_report` is computed from
 * `orders.totalMinor`, so a shop that imports products and invoices but not
 * orders gets a confidently empty revenue figure. That is worse than an error.
 */

export interface RowError {
  /** 1-based row number in the file, including the header. */
  row: number;
  field?: string;
  message: string;
}

export type ImportKind = "products" | "invoices" | "orders";

export interface ImportResult {
  kind: ImportKind;
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
/* Orders                                                               */
/* ------------------------------------------------------------------ */

/**
 * Maps whatever the export calls a status onto our enum.
 *
 * The mapping is not cosmetic: `sales_report` excludes `cancelled`, so an order
 * that was voided must land as `cancelled` or it inflates revenue. An
 * unrecognised value is reported rather than guessed.
 */
function mapOrderStatus(raw: string): { status: "new" | "confirmed" | "fulfilled" | "cancelled" } | null {
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!v) return { status: "fulfilled" };
  if (["new", "pending", "open"].includes(v)) return { status: "new" };
  if (["confirmed", "accepted", "processing"].includes(v)) return { status: "confirmed" };
  if (["fulfilled", "fulfilled_", "complete", "completed", "delivered", "paid", "sold"].includes(v)) {
    return { status: "fulfilled" };
  }
  if (["cancelled", "canceled", "void", "voided", "returned", "refunded"].includes(v)) {
    return { status: "cancelled" };
  }
  return null;
}

interface StagedLine {
  row: number;
  sku: string;
  description: string;
  quantity: number;
  unitPriceMinor: number;
}

interface StagedOrder {
  row: number;
  reference: string;
  contactId: string | null;
  totalMinor: number;
  status: "new" | "confirmed" | "fulfilled" | "cancelled";
  placedAt: Date;
  lines: StagedLine[];
}

/**
 * Imports historical sales.
 *
 * Accepts the two shapes a POS actually exports:
 *
 *   long  one row per line item, order reference repeated  (most common)
 *   wide  one row per order, a total, optionally a line
 *
 * Both work because rows are grouped on the reference, so a long export is not
 * mistaken for duplicate orders.
 */
export async function importOrders(
  tenantId: string,
  table: CsvTable,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const db = await getDb();

  const result: ImportResult = {
    kind: "orders",
    dryRun: opts.dryRun ?? true,
    total: table.records.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    warnings: [],
  };

  // Contact lookup, shared with the invoice importer: an export writes
  // "+234 802 000 0002" where we stored "2348020000002".
  const existingContacts = await db
    .select({ id: contacts.id, waId: contacts.waId })
    .from(contacts)
    .where(eq(contacts.tenantId, tenantId));

  const contactLookup = new Map<string, string>();
  for (const contact of existingContacts) {
    contactLookup.set(contact.waId, contact.id);
    contactLookup.set(normalisePhone(contact.waId), contact.id);
  }

  // SKU -> product, so a line item can be linked and named from the catalogue.
  const catalogue = await db
    .select({ id: products.id, sku: products.sku, name: products.name })
    .from(products)
    .where(eq(products.tenantId, tenantId));
  const productBySku = new Map(catalogue.map((p) => [p.sku.toLowerCase(), p]));

  const staged = new Map<string, StagedOrder>();

  table.records.forEach((record, index) => {
    const row = index + 2; // 1-based, plus the header

    const reference = pick(record, "order_ref");
    if (!reference) {
      result.errors.push({ row, field: "order_ref", message: "Missing order reference" });
      return;
    }

    let order = staged.get(reference);
    if (!order) {
      const placedOn = parseDate(pick(record, "placed_on"));
      if (pick(record, "placed_on") && !placedOn) {
        result.errors.push({
          row,
          field: "placed_on",
          message: `Could not read "${pick(record, "placed_on")}". Use YYYY-MM-DD or DD/MM/YYYY.`,
        });
        return;
      }

      const mapped = mapOrderStatus(pick(record, "status"));
      if (!mapped) {
        result.errors.push({
          row,
          field: "status",
          message: `"${pick(record, "status")}" is not a status I recognise ` +
            `(new, confirmed, fulfilled, cancelled).`,
        });
        return;
      }

      const waIdRaw = pick(record, "wa_id");
      const contactId = waIdRaw
        ? (contactLookup.get(waIdRaw) ??
          contactLookup.get(normalisePhone(waIdRaw)) ??
          null)
        : null;

      order = {
        row,
        reference,
        contactId,
        // Filled from the file if present, otherwise derived from the lines.
        totalMinor: 0,
        status: mapped.status,
        // Historical sales without a date land on today, which silently
        // flatters the report. Warned about rather than blocked, because a
        // shop with undated history is still better off imported.
        placedAt: placedOn ?? new Date(),
        lines: [],
      };
      staged.set(reference, order);

      if (!placedOn) {
        result.warnings.push(
          `Row ${row}: order ${reference} has no date; recorded as today.`,
        );
      }
      if (!contactId && waIdRaw) {
        result.warnings.push(
          `Row ${row}: order ${reference} has a WhatsApp number that matches no ` +
            `known customer; recorded without one.`,
        );
      }
    }

    // The order-level total, if the file carries one.
    const amountRaw = pick(record, "amount").replace(/[₦,\s]/g, "");
    if (amountRaw) {
      const amount = Number(amountRaw);
      if (!Number.isFinite(amount) || amount < 0) {
        result.errors.push({
          row,
          field: "amount",
          message: `"${pick(record, "amount")}" is not a valid amount`,
        });
        return;
      }
      const minor = toMinor(amount);
      if (order.totalMinor && order.totalMinor !== minor) {
        // A long export repeats the total on each line; that is not a conflict.
        // A wide export with two different totals is, and guessing one would
        // misreport revenue.
        result.warnings.push(
          `Row ${row}: order ${reference} has a different total on each row ` +
            `(₦${(order.totalMinor / 100).toFixed(2)} vs ₦${(minor / 100).toFixed(2)}); ` +
            `using the first.`,
        );
      } else {
        order.totalMinor = minor;
      }
    }

    // An optional line item.
    const sku = pick(record, "sku");
    const qtyRaw = pick(record, "line_qty");
    if (!sku || !qtyRaw) return;

    const quantity = Number.parseInt(qtyRaw.replace(/[,\s]/g, ""), 10);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      result.errors.push({
        row,
        field: "line_qty",
        message: `"${qtyRaw}" is not a quantity`,
      });
      return;
    }

    const unitPriceRaw = pick(record, "line_price").replace(/[₦,\s]/g, "");
    let unitPriceMinor = 0;
    if (unitPriceRaw) {
      const price = Number(unitPriceRaw);
      if (!Number.isFinite(price) || price < 0) {
        result.errors.push({
          row,
          field: "line_price",
          message: `"${pick(record, "line_price")}" is not a valid amount`,
        });
        return;
      }
      unitPriceMinor = toMinor(price);
    } else {
      // Not fatal: a sales total is what the report reads.
      result.warnings.push(
        `Row ${row}: ${sku} on order ${reference} has no unit price; recorded as 0.`,
      );
    }

    const product = productBySku.get(sku.toLowerCase());
    order.lines.push({
      row,
      sku,
      // Snapshot the name. Products get renamed; historical orders must not
      // change meaning because someone edited the catalogue.
      description: pick(record, "name") || product?.name || sku,
      quantity,
      unitPriceMinor,
    });
  });

  // Derive a total for any order whose file gave none. The report reads
  // totalMinor, so leaving it at zero would understate revenue to nothing.
  for (const order of staged.values()) {
    if (order.totalMinor === 0 && order.lines.length > 0) {
      order.totalMinor = order.lines.reduce(
        (sum, line) => sum + line.quantity * line.unitPriceMinor,
        0,
      );
    }
    if (order.totalMinor === 0) {
      result.warnings.push(
        `Row ${order.row}: order ${order.reference} has no total and no priced ` +
          `lines; imported at 0.`,
      );
    }
  }

  if (result.errors.length > 0 || opts.dryRun) {
    if (opts.dryRun) result.created = staged.size;
    return result;
  }

  for (const order of staged.values()) {
    // Upsert on (tenant, reference): shops re-export the same history.
    const [existing] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.reference, order.reference)))
      .limit(1);

    const orderId = existing
      ? (
          await db
            .update(orders)
            .set({
              totalMinor: order.totalMinor,
              status: order.status,
              placedAt: order.placedAt,
              contactId: order.contactId,
            })
            .where(eq(orders.id, existing.id))
            .returning()
        )[0]?.id
      : (
          await db
            .insert(orders)
            .values({
              tenantId,
              reference: order.reference,
              totalMinor: order.totalMinor,
              status: order.status,
              placedAt: order.placedAt,
              contactId: order.contactId,
              // Imported history did not come in over WhatsApp.
              source: "import",
            })
            .returning()
        )[0]?.id;

    if (!orderId) continue;

    // The file is the source of truth for this order's lines, so replace them
    // rather than merge. Merging would accumulate duplicates on every re-import.
    await db.delete(orderItems).where(eq(orderItems.orderId, orderId));

    if (order.lines.length > 0) {
      await db.insert(orderItems).values(
        order.lines.map((line) => ({
          tenantId,
          orderId,
          productId: productBySku.get(line.sku.toLowerCase())?.id ?? null,
          description: line.description,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
        })),
      );
    }

    if (existing) result.updated++;
    else result.created++;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                             */
/* ------------------------------------------------------------------ */

export async function importCsv(
  tenantId: string,
  csv: string,
  kind: ImportKind = "products",
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

  if (kind === "products") return importProducts(tenantId, table, opts);
  if (kind === "invoices") return importInvoices(tenantId, table, opts);
  return importOrders(tenantId, table, opts);
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
      orders: sql<number>`(select count(*)::int from orders where tenant_id = ${tenantId})`,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row ?? { products: 0, invoices: 0, orders: 0 };
}
