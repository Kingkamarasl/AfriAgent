"use client";

import { useState, useTransition } from "react";
import { simulateInboundAction } from "@/app/actions";

/**
 * WhatsApp playground.
 *
 * Stands in for the real thing until a WABA exists. Type as the owner to
 * exercise the command flow, or as a customer to exercise the support flow --
 * the same message means different things depending on who sent it.
 */

const OWNER_WA_ID = "2348010000001";
const CUSTOMER_WA_ID = "2348020000002";

const PRESETS: Array<{ label: string; from: string; text: string }> = [
  {
    label: "Multi-intent owner message",
    from: OWNER_WA_ID,
    text: "Show me today's sales, remind customers with overdue invoices, and tell me which products are running low",
  },
  { label: "Sales only", from: OWNER_WA_ID, text: "How much did I make today?" },
  { label: "Chase invoices", from: OWNER_WA_ID, text: "Remind customers with overdue invoices" },
  { label: "Customer asks about stock", from: CUSTOMER_WA_ID, text: "Do you have Peak milk powder in stock?" },
  { label: "Customer wants a human", from: CUSTOMER_WA_ID, text: "I want to speak to someone about my invoice" },
];

export function Playground() {
  const [text, setText] = useState("");
  const [asOwner, setAsOwner] = useState(true);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function send(from: string, body: string) {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const res = await simulateInboundAction(body, from);
      if (!res.ok) {
        setError(res.error ?? "Failed");
        return;
      }
      setResult(
        `${res.taskCount} task${res.taskCount === 1 ? "" : "s"} created · ` +
          `sender resolved as ${res.role}`,
      );
    });
  }

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">
          WhatsApp simulator
        </h2>
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          no Meta creds needed
        </span>
      </header>

      <div className="mb-3 flex rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
        {(
          [
            ["owner", OWNER_WA_ID],
            ["customer", CUSTOMER_WA_ID],
          ] as const
        ).map(([label, waId]) => (
          <button
            key={label}
            onClick={() => setAsOwner(label === "owner")}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium capitalize transition ${
              asOwner === (label === "owner")
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50"
                : "text-zinc-600 dark:text-zinc-400"
            }`}
          >
            Send as {label}
          </button>
        ))}
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder={
          asOwner
            ? "Show me today's sales, remind overdue invoices, what's running low?"
            : "Hi, do you have milk in stock?"
        }
        className="w-full resize-none rounded-lg border border-zinc-300 bg-white p-3 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
      />

      <div className="mt-2 flex items-center gap-2">
        <button
          disabled={isPending || !text.trim()}
          onClick={() => send(asOwner ? OWNER_WA_ID : CUSTOMER_WA_ID, text.trim())}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {isPending ? "Sending…" : "Send message"}
        </button>
        {text && (
          <button
            onClick={() => {
              setText("");
              setResult(null);
            }}
            className="text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400"
          >
            Clear
          </button>
        )}
      </div>

      {result && (
        <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
          {result}
        </p>
      )}
      {error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <p className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Try one of these
        </p>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              disabled={isPending}
              onClick={() => {
                setText(p.text);
                setAsOwner(p.from === OWNER_WA_ID);
                send(p.from, p.text);
              }}
              className="rounded-full border border-zinc-300 px-2.5 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
