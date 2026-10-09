import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/lib/auth/session";
import { RegisterForm } from "./RegisterForm";
export const dynamic = "force-dynamic";
export default async function RegisterPage() {
  if (await getCurrentActor()) redirect("/");
  return <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-5 py-12"><section className="w-full max-w-lg rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm"><Link href="/" className="text-sm font-semibold text-emerald-700">AfriAgent</Link><h1 className="mt-6 text-3xl font-semibold tracking-tight">Create your workspace</h1><p className="mt-2 text-sm text-zinc-600">Set up your business account. Your workspace is isolated from other businesses.</p><RegisterForm /><p className="mt-6 text-center text-sm text-zinc-600">Already have an account? <Link href="/login" className="font-semibold text-emerald-700 hover:underline">Sign in</Link></p></section></main>;
}
