import Link from "next/link";
import {
  checkAuthToken,
  consumeAuthToken,
  markEmailVerified,
} from "@/lib/auth/tokens";

export const dynamic = "force-dynamic";

/**
 * Email verification landing page.
 *
 * Opened from an email client, so the token in the URL is the whole
 * authorisation -- there is no session to rely on.
 *
 * This page grants nothing by itself: verification state lives on the user
 * record. That is why a refresh showing "already used" is treated as success
 * rather than an error. Someone following an old forwarded link also sees
 * "confirmed", and learns nothing they could not already see.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise.
  searchParams: Promise<{ token?: string }>;
}) {
  const { token = "" } = await searchParams;
  const check = await checkAuthToken(token, "verify_email");

  let title: string;
  let body: string;
  let tone: "good" | "bad";

  if (!check.ok) {
    if (check.reason === "already_used") {
      // The link already did its job.
      tone = "good";
      title = "Email confirmed";
      body = "This address is confirmed. Nothing more to do.";
    } else if (check.reason === "expired") {
      tone = "bad";
      title = "This link has expired";
      body = "Request a new one from your dashboard and it will arrive in a moment.";
    } else {
      tone = "bad";
      title = "This link is not valid";
      body = "Check that you copied the whole link from the email.";
    }
  } else if (!(await consumeAuthToken(token, "verify_email"))) {
    // Lost a race with another request for the same link.
    tone = "good";
    title = "Email confirmed";
    body = "This address is confirmed.";
  } else {
    await markEmailVerified(check.value.userId);
    tone = "good";
    title = "Email confirmed";
    body = "You can now recover your account if you ever lose your password.";
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-8 text-center">
      <h1
        className={`text-2xl font-semibold ${
          tone === "good"
            ? "text-emerald-700 dark:text-emerald-400"
            : "text-amber-700 dark:text-amber-400"
        }`}
      >
        {title}
      </h1>
      <p className="text-zinc-600 dark:text-zinc-400">{body}</p>
      <Link
        href="/"
        className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 dark:bg-emerald-600 dark:hover:bg-emerald-700"
      >
        Go to your dashboard
      </Link>
    </main>
  );
}
