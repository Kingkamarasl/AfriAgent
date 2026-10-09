"use client";
import { useActionState } from "react";
import { registerAction, type AuthFormState } from "@/app/auth-actions";

const initialState: AuthFormState = {};
export function RegisterForm() {
  const [state, action, pending] = useActionState(registerAction, initialState);
  return <form action={action} className="mt-8 space-y-4">
    <div><label htmlFor="businessName" className="mb-1.5 block text-sm font-medium">Business name</label><input id="businessName" name="businessName" autoComplete="organization" required minLength={2} maxLength={100} className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" placeholder="e.g. Monrovia Fresh Market" /></div>
    <div><label htmlFor="name" className="mb-1.5 block text-sm font-medium">Your full name</label><input id="name" name="name" autoComplete="name" required minLength={2} maxLength={100} className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" /></div>
    <div><label htmlFor="email" className="mb-1.5 block text-sm font-medium">Work email</label><input id="email" name="email" type="email" autoComplete="email" required maxLength={254} className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" /></div>
    <div><label htmlFor="country" className="mb-1.5 block text-sm font-medium">Country</label><select id="country" name="country" defaultValue="LR" className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-3"><option value="LR">Liberia</option><option value="GH">Ghana</option><option value="NG">Nigeria</option><option value="SL">Sierra Leone</option><option value="GM">The Gambia</option><option value="KE">Kenya</option><option value="ZA">South Africa</option><option value="US">United States</option><option value="GB">United Kingdom</option></select></div>
    <div><label htmlFor="password" className="mb-1.5 block text-sm font-medium">Password</label><input id="password" name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" /><p className="mt-1 text-xs text-zinc-500">Use at least 12 characters.</p></div>
    {state.error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{state.error}</p>}
    <button disabled={pending} className="w-full rounded-xl bg-emerald-700 px-4 py-3 font-semibold text-white hover:bg-emerald-800 disabled:opacity-60">{pending ? "Creating workspace…" : "Create free workspace"}</button>
    <p className="text-xs leading-relaxed text-zinc-500">By creating an account, you confirm you are authorised to create this business workspace. Email verification and account recovery will be added before public launch.</p>
  </form>;
}
