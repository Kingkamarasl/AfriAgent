import { redirect } from "next/navigation";
import { getCurrentActor } from "@/lib/auth/session";
import { logoutAction } from "@/app/auth-actions";
import { listFacts } from "@/domain/knowledge";
import { KnowledgeManager, type FactRow } from "@/components/KnowledgeManager";
import { AppNav } from "@/components/AppNav";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  const actor = await getCurrentActor();
  if (!actor) redirect("/login");

  const rows: FactRow[] = (await listFacts(actor.tenantId)).map((f) => ({
    id: f.id,
    topic: f.topic,
    tier: f.tier,
    status: f.status,
    subject: f.subject,
    value: f.value,
    provenance: f.provenance,
    updatedAt: f.updatedAt.toISOString(),
  }));

  const canEdit = actor.role === "owner" || actor.role === "manager";

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold">What your assistant knows</h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {actor.tenantName} · {canEdit ? "you can edit" : "read only"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm font-medium">{actor.name}</p>
            <form action={logoutAction}>
              <button
                type="submit"
                className="mt-1 text-xs font-semibold text-emerald-700 hover:underline"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-6">
        <AppNav current="/knowledge" />

        <div className="mb-5 rounded-xl border border-zinc-200 bg-white p-4 text-sm leading-relaxed text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          <p className="mb-2 font-medium text-zinc-900 dark:text-zinc-100">
            This is the only thing the assistant is allowed to say as fact.
          </p>
          <p>
            It can read anything here, but it may only state an{" "}
            <strong>authoritative</strong> fact to a customer, and it must be
            published first. Anything marked{" "}
            <strong>informational</strong> is background it will never quote.
            When it cannot find an authoritative answer it hands over to a
            human rather than guessing — so leaving this page thin means more
            escalations, not more confident wrong answers.
          </p>
        </div>

        <KnowledgeManager facts={rows} canEdit={canEdit} />
      </div>
    </div>
  );
}
