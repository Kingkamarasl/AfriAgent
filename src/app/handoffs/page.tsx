import { redirect } from "next/navigation";
import { getCurrentActor } from "@/lib/auth/session";
import { logoutAction } from "@/app/auth-actions";
import { listHandoffs } from "@/domain/handoffs";
import { HandoffQueue, type HandoffItem } from "@/components/HandoffQueue";
import { AppNav } from "@/components/AppNav";

export const dynamic = "force-dynamic";

export default async function HandoffsPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect("/login");

  const rows = await listHandoffs(actor.tenantId);

  const items: HandoffItem[] = rows.map((h) => ({
    id: h.id,
    reason: h.reason,
    status: h.status,
    contactName: h.contactName,
    contactWaId: h.contactWaId,
    contactPhone: h.contactPhone,
    claimedAt: h.claimedAt?.toISOString() ?? null,
    createdAt: h.createdAt.toISOString(),
    context: h.context,
  }));

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold">Waiting on a human</h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {actor.tenantName} · {items.length} open
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
        <AppNav current="/handoffs" />

        <div className="mb-5 rounded-xl border border-zinc-200 bg-white p-4 text-sm leading-relaxed text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          The assistant hands over whenever it cannot find something it is
          willing to stand behind. That is the behaviour working, not failing —
          but the customer has already been told someone will reply, so these
          need picking up.
        </div>

        <HandoffQueue items={items} />
      </div>
    </div>
  );
}
