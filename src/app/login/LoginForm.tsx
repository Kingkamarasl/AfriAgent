"use client";
import Link from "next/link";
import { useActionState } from "react";
import { loginAction, type AuthFormState } from "@/app/auth-actions";

const initialState: AuthFormState = {};
export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, initialState);
  return <form action={action} className="mt-8 space-y-5">
    <div><label htmlFor="email" className="mb-1.5 block text-sm font-medium">Email address</label><input id="email" name="email" type="email" autoComplete="email" required maxLength={254} className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" /></div>
    <div><label htmlFor="password" className="mb-1.5 block text-sm font-medium">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required maxLength={128} className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" /></div>
    {state.error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{state.error}</p>}
    <button disabled={pending} className="w-full rounded-xl bg-emerald-700 px-4 py-3 font-semibold text-white hover:bg-emerald-800 disabled:opacity-60">{pending ? "Signing in…" : "Sign in"}</button>
    <p className="text-center text-sm"><Link href="/forgot-password" className="text-emerald-700 hover:underline">Forgotten your password?</Link></p>
  </form>;
}
