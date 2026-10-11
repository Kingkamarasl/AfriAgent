"use client";

import { useState, useTransition } from "react";
import {
  createFactAction,
  deleteFactAction,
  setFactStatusAction,
  updateFactAction,
  type FactFormState,
} from "@/app/knowledge/actions";

/**
 * Knowledge base editor.
 *
 * The tier chooser is the important control here, so the consequence is
 * spelled out next to it rather than in a tooltip: an `authoritative` fact
 * becomes something the assistant may tell a customer as fact, while an
 * `informational` one is context it may only read.
 */

const TOPICS = [
  ["price", "Price"],
  ["service", "Service or product"],
  ["hours", "Opening hours"],
  ["location", "Location"],
  ["policy", "Policy"],
  ["contact", "Contact details"],
  ["delivery", "Delivery"],
  ["faq", "Background / FAQ"],
] as const;

export interface FactRow {
  id: string;
  topic: string;
  tier: "authoritative" | "informational";
  status: "active" | "draft" | "archived";
  subject: string;
  value: string;
  provenance: string | null;
  updatedAt: string;
}

const TIER_STYLE: Record<string, string> = {
  authoritative:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  informational:
    "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900",
  draft: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-900",
  archived: "bg-zinc-100 text-zinc-500 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-500 dark:ring-zinc-700",
};

export function KnowledgeManager({
  facts,
  canEdit,
}: {
  facts: FactRow[];
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [filter, setFilter] = useState<"all" | "active" | "draft" | "archived">("all");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const visible = facts.filter((f) => filter === "all" || f.status === filter);

  function run(fn: () => Promise<FactFormState>, successMessage?: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Something went wrong");
      else if (successMessage) setNotice(successMessage);
    });
  }

  function fd(fields: Record<string, string>): FormData {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return form;
  }

  return (
    <div className="space-y-4">
      {!canEdit && (
        <p className="rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          You can read this page, but only owners and managers can change what
          the assistant tells customers.
        </p>
      )}

      {canEdit && (
        <button
          onClick={() => setShowNew((v) => !v)}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 dark:bg-emerald-600 dark:hover:bg-emerald-700"
        >
          {showNew ? "Close" : "Add a fact"}
        </button>
      )}

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

      {showNew && canEdit && (
        <FactForm
          key="new"
          submitLabel="Save as draft"
          onSubmit={(values) =>
            run(() => createFactAction({ ok: true }, fd(values)), "Saved as a draft. Publish it when you are happy with the wording.")
          }
          isPending={isPending}
        />
      )}

      <div className="flex flex-wrap gap-1.5">
        {(["all", "active", "draft", "archived"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${
              filter === f
                ? "bg-zinc-900 text-white dark:bg-emerald-600"
                : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {f} ({f === "all" ? facts.length : facts.filter((x) => x.status === f).length})
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          Nothing here yet. The assistant can only answer from what you record —
          without opening hours and policies it will escalate every question.
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((fact) =>
            editing === fact.id ? (
              <li key={fact.id}>
                <FactForm
                  initial={fact}
                  submitLabel="Save changes"
                  onSubmit={(values) =>
                    run(
                      () => updateFactAction({ ok: true }, fd({ ...values, id: fact.id })),
                      "Saved.",
                    )
                  }
                  onCancel={() => setEditing(null)}
                  isPending={isPending}
                />
              </li>
            ) : (
              <li
                key={fact.id}
                className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLE[fact.status]}`}
                      >
                        {fact.status}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${TIER_STYLE[fact.tier]}`}
                      >
                        {fact.tier}
                      </span>
                      <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                        {TOPICS.find(([t]) => t === fact.topic)?.[1] ?? fact.topic}
                      </span>
                    </div>
                    <p className="mt-1 font-medium text-zinc-900 dark:text-zinc-100">
                      {fact.subject}
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-400">
                      {fact.value}
                    </p>
                  </div>

                  {canEdit && (
                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      <SmallButton
                        onClick={() => setEditing(fact.id)}
                        disabled={isPending}
                      >
                        Edit
                      </SmallButton>
                      {fact.status !== "active" ? (
                        <SmallButton
                          disabled={isPending}
                          onClick={() =>
                            run(
                              () =>
                                setFactStatusAction(
                                  { ok: true },
                                  fd({ id: fact.id, status: "active" }),
                                ),
                              "Published. The assistant may now state this to customers.",
                            )
                          }
                          tone="primary"
                        >
                          Publish
                        </SmallButton>
                      ) : (
                        <SmallButton
                          disabled={isPending}
                          onClick={() =>
                            run(
                              () =>
                                setFactStatusAction(
                                  { ok: true },
                                  fd({ id: fact.id, status: "draft" }),
                                ),
                              "Unpublished. Customers will stop being told this.",
                            )
                          }
                        >
                          Unpublish
                        </SmallButton>
                      )}
                      {fact.status !== "archived" && (
                        <SmallButton
                          disabled={isPending}
                          onClick={() =>
                            run(
                              () =>
                                setFactStatusAction(
                                  { ok: true },
                                  fd({ id: fact.id, status: "archived" }),
                                ),
                              "Archived.",
                            )
                          }
                        >
                          Archive
                        </SmallButton>
                      )}
                      <SmallButton
                        disabled={isPending}
                        tone="danger"
                        onClick={() =>
                          run(
                            () => deleteFactAction({ ok: true }, fd({ id: fact.id })),
                            "Deleted.",
                          )
                        }
                      >
                        Delete
                      </SmallButton>
                    </div>
                  )}
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function SmallButton({
  children,
  onClick,
  disabled,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "primary" | "danger";
}) {
  const tones = {
    default:
      "border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800",
    primary:
      "border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
    danger:
      "border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-2 py-1 text-[11px] font-medium disabled:opacity-50 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

function FactForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  isPending,
}: {
  initial?: FactRow;
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => void;
  onCancel?: () => void;
  isPending: boolean;
}) {
  const [tier, setTier] = useState<"authoritative" | "informational">(
    initial?.tier ?? "authoritative",
  );
  const [topic, setTopic] = useState(initial?.topic ?? "service");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [value, setValue] = useState(initial?.value ?? "");

  return (
    <form
      className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ subject, value, topic, tier });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Topic
          <select
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            {TOPICS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Tier
          <div className="mt-1 flex gap-1">
            {(["authoritative", "informational"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTier(t)}
                className={`flex-1 rounded-lg border px-2 py-2 text-[11px] font-medium ${
                  tier === t
                    ? "border-emerald-400 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
                    : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="rounded-lg bg-zinc-50 px-3 py-2 text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400">
        {tier === "authoritative" ? (
          <>
            <strong className="text-emerald-700 dark:text-emerald-400">
              Authoritative:
            </strong>{" "}
            the assistant may state this to customers as fact, and must cite it.
            Use for prices, hours, policies and anything you would be held to.
          </>
        ) : (
          <>
            <strong>Informational:</strong> the assistant may read this for tone
            and context but will never quote it as fact. Use for FAQs and
            background.
          </>
        )}
      </p>

      <input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Subject, e.g. Opening hours"
        className="w-full rounded-lg border border-zinc-300 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
      />

      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        placeholder="The fact itself, written the way you would say it."
        className="w-full rounded-lg border border-zinc-300 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
      />

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {isPending ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
