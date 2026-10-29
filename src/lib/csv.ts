/**
 * Minimal RFC 4180 CSV parser.
 *
 * Hand-written rather than pulled in as a dependency because the correctness
 * details are what matter here and shop exports are messy: Excel on Windows
 * emits CRLF and a UTF-8 BOM, and product names legitimately contain commas
 * and newlines ("Bread, sliced" / multi-line descriptions). A naive
 * `split(",")` corrupts exactly the rows that matter most.
 */

export function parseCsv(input: string, delimiter = ","): string[][] {
  // Excel writes a BOM; without stripping it the first header becomes
  // "\uFEFFsku" and every row fails validation.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // Escaped quote.
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i++;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
      i++;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }

    field += ch;
    i++;
  }

  // Flush the trailing field unless the file ended on a clean newline.
  if (field.length > 0 || row.length > 0) endRow();

  // Drop blank lines, which trailing newlines and stray separators produce.
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ""));
}

export interface CsvTable {
  headers: string[];
  records: Array<Record<string, string>>;
}

/** Zip a header row onto the rows beneath it, normalising header names. */
export function toTable(rows: string[][]): CsvTable {
  if (rows.length === 0) return { headers: [], records: [] };

  const headers = rows[0]!.map((h) => normaliseHeader(h));

  const records = rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (!header) return;
      record[header] = (row[index] ?? "").trim();
    });
    return record;
  });

  return { headers, records };
}

/** "Unit Price", "unit_price", "unit-price" all become `unit_price`. */
function normaliseHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Aliases, so an export from any of the common tools just works. */
const ALIASES: Record<string, string[]> = {
  sku: ["sku", "code", "item_code", "product_code"],
  name: ["name", "product", "product_name", "item", "description"],
  unit: ["unit", "units", "uom"],
  stock: ["stock", "stock_qty", "quantity", "qty", "on_hand", "balance"],
  reorder_level: ["reorder_level", "reorder", "min_stock", "minimum"],
  unit_price: ["unit_price", "price", "cost", "selling_price", "rate"],
  invoice_number: ["number", "invoice_number", "invoice_no", "inv_no", "ref"],
  customer: ["customer", "customer_name", "client", "name", "account"],
  wa_id: ["wa_id", "whatsapp", "whatsapp_id", "phone", "msisdn", "mobile"],
  amount: ["amount", "total", "value", "amount_due", "balance"],
  issued_on: ["issued_on", "issued", "date", "invoice_date", "date_issued"],
  due_on: ["due_on", "due", "due_date", "payment_due"],
  // Orders. `sku`/`amount` are reused from above because a POS export names
  // them the same way -- an order total really is an `amount`, and a line item
  // really is a `sku`.
  order_ref: ["order_ref", "order", "order_number", "order_no", "ref_no", "reference"],
  placed_on: ["placed_on", "placed", "order_date", "sold_at", "date", "created_at"],
  line_qty: ["line_qty", "qty", "quantity", "units"],
  line_price: ["line_price", "price", "unit_price"],
  status: ["status", "order_status", "state"],
};

export function pick(record: Record<string, string>, field: keyof typeof ALIASES): string {
  for (const alias of ALIASES[field]!) {
    const value = record[alias];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}
