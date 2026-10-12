"use client";

import Link from "next/link";
import { useActionState } from "react";
import { forgotPasswordAction, type AuthFormState } from "@/app/auth-actions";
import { AuthCard, Field, Notice, Submit } from "@/components/AuthForm";

// `error: undefined` means "not submitted yet". Using "" reads as a successful
// submission and would render the confirmation instead of the form.
const initial: AuthFormState = {};

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(forgotPasswordAction, initial);

  return (
    <AuthCard
      title="Reset your password"
      subtitle="We'll email you a link to set a new one."
      footer={
        <Link
          href="/login"
          className="text-zinc-600 hover:underline dark:text-zinc-400"
        >
          Back to sign in
        </Link>
      }
    >
      {/* The same message whether or not an account exists. Anything else
          turns this form into an account-enumeration oracle. */}
      {state.error === "" ? (
        <div className="space-y-4">
          <Notice tone="success">
            If that address has a confirmed account, a reset link is on its way.
            It works for one hour.
          </Notice>
          <Link
            href="/login"
            className="block w-full rounded-lg bg-zinc-900 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-zinc-800 dark:bg-emerald-600 dark:hover:bg-emerald-700"
          >
            Back to sign in
          </Link>
        </div>
      ) : (
        <form action={action} className="space-y-4">
          <Notice>{state.error}</Notice>
          <Field
            label="Email address"
            name="email"
            type="email"
            autoComplete="email"
            required
          />
          <Submit pending={pending}>Email me a reset link</Submit>
        </form>
      )}
    </AuthCard>
  );
}
