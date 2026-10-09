"use client";

import { useRef, useState, useTransition } from "react";

/**
 * CSV import.
 *
 * Two-step by contract: pick a file, see exactly what would happen, then
 * commit. The shop owner's first spreadsheet will have mistakes in it, and
 * showing the row and column beats a generic "import failed".
 */

type Kind = "products" | "invoices";

interface ImportResponse {
  kind: Kind;
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; field?: string; message: string }>;
  warnings: string[];
  committed: boolean;
  blocked: boolean;
  current?: { products: number; invoices: number };
}

export function ImportPanel() {
  const [kind, setKind] = useState<Kind>("products");
  const [preview, setPreview] = useState<ImportResponse | null>(null);
  const [done, setDone] = useState<ImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const csvRef = useRef<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function send(commit: boolean) {
    if (!csvRef.current) return;
    setError(null);
    setDone(null);

    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/import?kind=${kind}${commit ? "&commit=1" : ""}`,
          {
            method: "POST",
            headers: { "content-type": "text/csv" },
            body: csvRef.current,
          },
        );
        const json = (await res.json()) as ImportResponse & { error?: string };

        if (!res.ok) {
          setError(json.error ?? `Import failed (HTTP ${res.status})`);
          return;
        }
        if (commit) setDone(json);
        else setPreview(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Import failed");
      }
    });
  }

  function onFile(file: File) {
    setError(null);
    setPreview(null);
    setDone(null);
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = () => {
      csvRef.current = String(reader.result ?? "");
      // Validate immediately -- the owner should not have to press a button
      // just to find out their file is broken.
      startTransition(async () => {
        const res = await fetch(`/api/import?kind=${kind}`, {
          method: "POST",
          headers: { "content-type": "text/csv" },
          body: csvRef.current,
        });
        const json = (await res.json()) as ImportResponse & { error?: string };
        if (!res.ok) setError(json.error ?? "Could not read that file");
        else setPreview(json);
      });
    };
    reader.readAsText(file);
  }

  const blocked = preview?.errors.length ? preview.errors.length : 0;

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">
        Import your catalogue
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        The agent can only help with what it can read. Upload your product list
        or outstanding invoices as a CSV.
      </p>

      <div className="mt-3 flex rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
        {(["products", "invoices"] as const).map((k) => (
          <button
            key={k}
            onClick={() => {
              setKind(k);
              setPreview(null);
              setDone(null);
            }}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium capitalize transition ${
              kind === k
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50"
                : "text-zinc-600 dark:text-zinc-400"
            }`}
          >
            {k}
          </button>
        ))}
      </div>

      <label className="mt-3 block cursor-pointer rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800/50">
        <input
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
          }}
        />
        {fileName ?? "Choose a CSV file"}
        <span className="mt-1 block text-[11px] text-zinc-400">
          {kind === "products"
            ? "sku, name, unit, stock, reorder_level, unit_price"
            : "number, customer_name, wa_id, amount, issued_on, due_on"}
        </span>
      </label>

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {error}
        </p>
      )}

      {preview && !done && (
        <div className="mt-3 space-y-2">
          <div className="rounded-lg bg-zinc-50 px-3 py-2 text-xs dark:bg-zinc-800/60">
            <p className="font-medium text-zinc-800 dark:text-zinc-200">
              {preview.total} row{preview.total === 1 ? "" : "s"} read
            </p>
            {blocked > 0 ? (
              <p className="text-red-600 dark:text-red-400">
                {blocked} problem{blocked === 1 ? "" : "s"} must be fixed before
                importing.
              </p>
            ) : (
              <p className="text-zinc-600 dark:text-zinc-400">
                Ready to import {preview.created} row
                {preview.created === 1 ? "" : "s"}.
              </p>
            )}
          </div>

          {preview.errors.length > 0 && (
            <ul className="max-h-32 space-y-1 overflow-auto text-[11px] text-red-700 dark:text-red-400">
              {preview.errors.map((e, i) => (
                <li key={i}>
                  Row {e.row}
                  {e.field ? `, ${e.field}` : ""}: {e.message}
                </li>
              ))}
            </ul>
          )}

          {preview.warnings.length > 0 && (
            <ul className="max-h-24 space-y-1 overflow-auto text-[11px] text-amber-700 dark:text-amber-400">
              {preview.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          <button
            disabled={isPending || blocked > 0 || preview.created === 0}
            onClick={() => send(true)}
            className="w-full rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-40 dark:bg-emerald-600 dark:hover:bg-emerald-700"
          >
            {isPending ? "Importing…" : `Import ${preview.created} rows`}
          </button>
        </div>
      )}

      {done && (
        <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
          <p className="font-medium">
            Imported {done.created} new, updated {done.updated}
            {done.skipped > 0 ? `, skipped ${done.skipped}` : ""}.
          </p>
          {done.current && (
            <p className="mt-0.5 text-emerald-700/80 dark:text-emerald-400/80">
              You now have {done.current.products} products and{" "}
              {done.current.invoices} invoices.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
