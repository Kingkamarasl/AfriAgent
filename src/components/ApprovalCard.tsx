"use client";

import { useState, useTransition } from "react";
import {
  approveAndSendAction,
  rejectAction,
  reviseDraftAction,
} from "@/app/actions";
import type { Task } from "@/db/schema";
import { formatMoney } from "@/lib/money";

/**
 * The approval gate.
 *
 * Everything the agent wants to send to a real customer lands here first.
 * The three outcomes -- send, reject, edit-then-send -- map exactly onto the
 * state machine, so this component cannot produce a state the backend would
 * reject.
 */

interface StoredResult {
  delivery?: {
    recipients?: Array<{ waId: string; preview: string }>;
  };
  overdueCount?: number;
  lowStockCount?: number;
}

export function ApprovalCard({ task }: { task: Task }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.draftBody ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const result = (task.result ?? {}) as StoredResult;
  const recipients = result.delivery?.recipients ?? [];
  const recipientCount = recipients.length;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Something went wrong");
    });
  }

  return (
    <article className="rounded-xl border border-amber-300/60 bg-amber-50/40 dark:border-amber-500/30 dark:bg-amber-950/20 p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">
            {task.title}
          </h3>
          {task.requestText && (
            <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">
              “{task.requestText}”
            </p>
          )}
        </div>
        <Meta task={task} />
      </header>

      {recipientCount > 0 && (
        <p className="mt-3 rounded-lg bg-white/70 px-3 py-2 text-sm font-medium text-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-300">
          This will send {recipientCount} separate reminder
          {recipientCount === 1 ? "" : "s"} — one per overdue customer.
        </p>
      )}

      <div className="mt-3">
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={10}
              className="w-full rounded-lg border border-zinc-300 bg-white p-3 font-mono text-xs text-zinc-800 focus:border-emerald-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
            <div className="flex gap-2">
              <button
                disabled={isPending}
                onClick={() => {
                  const fd = new FormData();
                  fd.set("draft", draft);
                  run(() => reviseDraftAction(task.id, fd));
                }}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Save &amp; re-approve
              </button>
              <button
                disabled={isPending}
                onClick={() => setEditing(false)}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 font-mono text-xs leading-relaxed text-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
            {task.draftBody ?? "—"}
          </pre>
        )}
      </div>

      {recipients.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-zinc-600 dark:text-zinc-400">
            Preview all {recipients.length} messages
          </summary>
          <div className="mt-2 space-y-2">
            {recipients.map((r, i) => (
              <div
                key={`${r.waId}-${i}`}
                className="rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900"
              >
                <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                  → {r.waId}
                </p>
                <p className="mt-1 whitespace-pre-wrap font-mono text-xs text-zinc-700 dark:text-zinc-300">
                  {r.preview}
                </p>
              </div>
            ))}
          </div>
        </details>
      )}

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {error}
        </p>
      )}

      {!editing && (
        <footer className="mt-4 flex flex-wrap gap-2">
          <button
            disabled={isPending}
            onClick={() => run(() => approveAndSendAction(task.id))}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
          >
            {isPending ? "Working…" : "Approve & send"}
          </button>
          <button
            disabled={isPending}
            onClick={() =>
              run(() => rejectAction(task.id, new FormData()))
            }
            className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Reject
          </button>
          <button
            disabled={isPending || !task.draftBody}
            onClick={() => setEditing(true)}
            className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Edit first
          </button>
        </footer>
      )}
    </article>
  );
}

/**
 * Shows what this task will *achieve*, never what it costs.
 *
 * A per-task price here reads as nickel-and-diming: one WhatsApp message
 * produced three cards, each with its own price, for work the owner asked for
 * in a single sentence. Reach is the number that sells it.
 */
function Meta({ task }: { task: Task }) {
  const result = (task.result ?? {}) as StoredResult;
  const reach = result.delivery?.recipients?.length ?? 0;
  const overdue = typeof result.overdueCount === "number" ? result.overdueCount : 0;
  const lowCount =
    typeof result.lowStockCount === "number" ? result.lowStockCount : 0;

  const facts: string[] = [];
  if (reach > 0) {
    facts.push(`${reach} customer${reach === 1 ? "" : "s"} will be contacted`);
  }
  if (overdue > 0) facts.push(`${overdue} invoice${overdue === 1 ? "" : "s"} overdue`);
  if (lowCount > 0) facts.push(`${lowCount} product${lowCount === 1 ? "" : "s"} low`);

  return (
    <div className="text-right text-xs text-zinc-500 dark:text-zinc-400">
      {facts.map((f) => (
        <p key={f}>{f}</p>
      ))}
      <p className="mt-0.5 text-zinc-400 dark:text-zinc-500">Included in your plan</p>
    </div>
  );
}
