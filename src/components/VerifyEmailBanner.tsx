"use client";

import { useState, useTransition } from "react";
import { resendVerificationAction } from "@/app/auth-actions";

/**
 * Shown while the owner's address is unproven.
 *
 * Deliberately a banner, not a gate. Blocking sign-in until someone clicks a
 * link in their email is how a shop owner ends up locked out of their own
 * dashboard. What verification actually gates is *password reset* -- the flow
 * where an unverified address is genuinely dangerous.
 */
export function VerifyEmailBanner() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/40">
      <p className="text-sm text-amber-900 dark:text-amber-200">
        <strong className="font-semibold">Confirm your email address.</strong>{" "}
        Until you do, password recovery is switched off for this account.
      </p>
      {sent ? (
        <span className="text-xs font-medium text-amber-800 dark:text-amber-300">
          Sent — check your inbox.
        </span>
      ) : (
        <button
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const res = await resendVerificationAction();
              if (res.error) setError(res.error);
              else setSent(true);
            })
          }
          className="rounded-lg border border-amber-400 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/40"
        >
          {isPending ? "Sending…" : "Resend confirmation"}
        </button>
      )}
      {error && (
        <span className="w-full text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      )}
    </div>
  );
}
