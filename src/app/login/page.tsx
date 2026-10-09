import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/lib/auth/session";
import { LoginForm } from "./LoginForm";
export const dynamic = "force-dynamic";
export default async function LoginPage() {
  if (await getCurrentActor()) redirect("/");
  return <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-5 py-12"><section className="w-full max-w-md rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm"><Link href="/" className="text-sm font-semibold text-emerald-700">AfriAgent</Link><h1 className="mt-6 text-3xl font-semibold tracking-tight">Welcome back</h1><p className="mt-2 text-sm text-zinc-600">Sign in to manage your business AI employee.</p><LoginForm /><p className="mt-6 text-center text-sm text-zinc-600">New to AfriAgent? <Link href="/register" className="font-semibold text-emerald-700 hover:underline">Create an account</Link></p></section></main>;
}
