"use client";

import { useState, useTransition } from "react";
import { retryAction } from "@/app/actions";

/** Re-queues a failed task. Only legal from `failed` -- enforced server-side. */
export function RetryButton({ taskId }: { taskId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <span className="inline-flex items-center gap-2">
      <button
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await retryAction(taskId);
            if (!res.ok) setError(res.error ?? "Retry failed");
          })
        }
        className="rounded-md border border-zinc-300 px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        {isPending ? "Retrying…" : "Retry"}
      </button>
      {error && <span className="text-[11px] text-red-600 dark:text-red-400">{error}</span>}
    </span>
  );
}
