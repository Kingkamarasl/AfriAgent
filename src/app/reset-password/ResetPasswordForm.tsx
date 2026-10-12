"use client";

import Link from "next/link";
import { useActionState } from "react";
import { resetPasswordAction, type AuthFormState } from "@/app/auth-actions";
import { AuthCard, Field, Notice, Submit } from "@/components/AuthForm";

// `error: undefined` means "not submitted yet". Using "" would render the
// "password changed" confirmation before anything had been submitted.
const initial: AuthFormState = {};

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(resetPasswordAction, initial);

  if (state.error === "" && token) {
    // Reset succeeded. Say so plainly and kill every session, which has
    // already happened server-side.
    return (
      <AuthCard title="Password changed" subtitle="You're signed out everywhere.">
        <Notice tone="success">
          Your new password is active. Every other session has been signed out,
          so if you did not do this, your account is safe.
        </Notice>
        <Link
          href="/login"
          className="mt-4 block w-full rounded-lg bg-zinc-900 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-zinc-800 dark:bg-emerald-600 dark:hover:bg-emerald-700"
        >
          Sign in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Choose a new password"
      subtitle="At least 12 characters."
      footer={
        <Link
          href="/login"
          className="text-zinc-600 hover:underline dark:text-zinc-400"
        >
          Back to sign in
        </Link>
      }
    >
      <form action={action} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <Notice>{state.error}</Notice>
        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
        />
        <Field
          label="Confirm new password"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
        />
        <Submit pending={pending}>Change my password</Submit>
      </form>
    </AuthCard>
  );
}
