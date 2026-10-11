"use client";

import { useState, useTransition } from "react";
import {
  claimHandoffAction,
  resolveHandoffAction,
} from "@/app/handoffs/actions";

export interface HandoffItem {
  id: string;
  reason: string;
  status: string;
  contactName: string | null;
  contactWaId: string | null;
  contactPhone: string | null;
  claimedAt: string | null;
  createdAt: string;
  context: Record<string, unknown>;
}

export function HandoffQueue({ items }: { items: HandoffItem[] }) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
        <p className="font-medium text-zinc-700 dark:text-zinc-300">
          Nothing waiting for a human
        </p>
        <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">
          Everything the assistant was asked has either been answered from your
          recorded knowledge or queued here. When it escalates, it is because it
          could not find a fact it was willing to stand behind.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
          {notice}
        </p>
      )}

      <ul className="space-y-3">
        {items.map((item) => (
          <li
            key={item.id}
            className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${
                      item.status === "claimed"
                        ? "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300"
                        : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                    }`}
                  >
                    {item.status}
                  </span>
                  <p className="font-medium text-zinc-900 dark:text-zinc-100">
                    {item.contactName ?? item.contactWaId ?? "Unknown contact"}
                  </p>
                  {item.contactPhone && (
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {item.contactPhone}
                    </span>
                  )}
                </div>

                <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
                  {item.reason}
                </p>

                {typeof item.context.question === "string" && (
                  <p className="mt-1 text-sm italic text-zinc-500 dark:text-zinc-400">
                    “{item.context.question}”
                  </p>
                )}

                {Array.isArray(item.context.toolsUsed) &&
                  item.context.toolsUsed.length > 0 && (
                    <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                      Looked at:{" "}
                      {(item.context.toolsUsed as string[]).join(", ")}
                    </p>
                  )}

                <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-500">
                  {new Date(item.createdAt).toLocaleString("en-NG", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </p>
              </div>

              <div className="shrink-0">
                {item.status === "open" ? (
                  <button
                    disabled={isPending}
                    onClick={() =>
                      startTransition(async () => {
                        setError(null);
                        setNotice(null);
                        const res = await claimHandoffAction(item.id);
                        if (!res.ok) setError(res.error ?? "Could not claim it");
                        else setNotice(res.notice ?? null);
                      })
                    }
                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    Claim
                  </button>
                ) : (
                  <ResolveForm id={item.id} isPending={isPending} />
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResolveForm({ id, isPending }: { id: string; isPending: boolean }) {
  const [note, setNote] = useState("");
  const [localPending, startLocal] = useTransition();
  const busy = isPending || localPending;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="How was it handled?"
        className="w-56 rounded-lg border border-zinc-300 bg-white p-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
      />
      <button
        disabled={busy}
        onClick={() =>
          startLocal(async () => {
            const form = new FormData();
            form.set("id", id);
            form.set("note", note);
            await resolveHandoffAction({ ok: true }, form);
          })
        }
        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        Mark resolved
      </button>
    </div>
  );
}
