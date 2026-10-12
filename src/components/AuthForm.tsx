"use client";

import Link from "next/link";

/**
 * Shared auth form shell.
 *
 * Every auth screen has the same three requirements: it must be clear about
 * what is happening, it must never be the only way to reach the product, and
 * it must not pretend to have succeeded. Those are easy to get subtly wrong
 * in six near-identical screens, so they live here once.
 */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <Link href="/" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        AfriAgent
      </Link>
      <h1 className="mt-4 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {title}
      </h1>
      {subtitle && (
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{subtitle}</p>
      )}
      <div className="mt-5">{children}</div>
      {footer && (
        <div className="mt-5 border-t border-zinc-200 pt-4 text-sm dark:border-zinc-800">
          {footer}
        </div>
      )}
    </div>
  );
}

export function Field({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
      {label}
      <input
        {...props}
        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-emerald-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
      />
    </label>
  );
}

export function Submit({
  children,
  pending,
}: {
  children: string;
  pending: boolean;
}) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
    >
      {pending ? "Working…" : children}
    </button>
  );
}

export function Notice({
  children,
  tone = "error",
}: {
  children?: React.ReactNode;
  tone?: "error" | "success";
}) {
  if (!children) return null;
  return (
    <p
      className={`rounded-lg px-3 py-2 text-sm ${
        tone === "error"
          ? "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300"
          : "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
      }`}
    >
      {children}
    </p>
  );
}
