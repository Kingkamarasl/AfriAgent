import { getDb } from "@/db/client";
import { tenants } from "@/db/schema";
import { Playground } from "@/components/Playground";
import { ImportPanel } from "@/components/ImportPanel";
import { ApprovalCard } from "@/components/ApprovalCard";
import { RetryButton } from "@/components/RetryButton";
import {
  listApprovalQueue,
  recentActivity,
  summariseUsage,
} from "@/domain/task-service";
import { TASK_KIND_LABEL, TASK_STATUS_LABEL } from "@/domain/tasks";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  pending_approval:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  sent: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  cancelled: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  running:
    "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
};

export default async function DashboardPage() {
  const db = await getDb();
  const [tenant] = await db.select().from(tenants).limit(1);

  if (!tenant) {
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          No business connected yet
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          Seed the demo shop to start exploring the task engine:
        </p>
        <code className="rounded-lg bg-zinc-900 px-4 py-2 font-mono text-sm text-emerald-400">
          npm run db:seed
        </code>
      </main>
    );
  }

  const [pending, activity, usage] = await Promise.all([
    listApprovalQueue(tenant.id),
    recentActivity(tenant.id, new Date(Date.now() - 7 * 86_400_000)),
    summariseUsage(tenant.id),
  ]);

  const overage = usage.overageUnits > 0;
  const remaining = Math.max(0, usage.includedUnits - usage.units);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold">
              AfriAgent
              <span className="ml-2 text-sm font-normal text-zinc-500 dark:text-zinc-400">
                {tenant.name}
              </span>
            </h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {tenant.country} · {tenant.timezone} ·{" "}
              {tenant.currency}
            </p>
          </div>

          {/* Billing is framed as subscription + overage, never as a running
              per-task tally. Showing "you were charged N times" for one
              message turns good value into nickel-and-diming. */}
          <div className="min-w-64 rounded-xl border border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                This month
              </span>
              <span className="text-xs font-semibold">
                {usage.units} task{usage.units === 1 ? "" : "s"} completed
              </span>
            </div>

            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div
                className={`h-full rounded-full ${overage ? "bg-red-500" : "bg-emerald-500"}`}
                style={{ width: `${usage.utilisationPct}%` }}
              />
            </div>

            <dl className="mt-2 space-y-0.5 text-[11px]">
              <div className="flex justify-between">
                <dt className="text-zinc-500 dark:text-zinc-400">Subscription</dt>
                <dd className="font-medium">
                  {formatMoney(usage.planMinor, tenant.currency)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-zinc-500 dark:text-zinc-400">
                  Overage ({usage.overageUnits} beyond {usage.includedUnits})
                </dt>
                <dd className="font-medium">
                  {formatMoney(usage.overageMinor, tenant.currency)}
                </dd>
              </div>
              <div className="flex justify-between border-t border-zinc-200 pt-0.5 dark:border-zinc-800">
                <dt className="font-medium">Due</dt>
                <dd className="font-semibold">
                  {formatMoney(usage.totalDueMinor, tenant.currency)}
                </dd>
              </div>
            </dl>

            <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              {overage
                ? `${usage.overageUnits} tasks beyond the included allowance`
                : `${remaining} included tasks remaining`}
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[380px_1fr]">
        <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <Playground />
          <ImportPanel />

          <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-2 font-semibold">How billing works</h2>
            <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              Your plan includes{" "}
              <strong>{usage.includedUnits} tasks a month</strong>. One
              WhatsApp message asking for three things counts as three tasks —
              and you see every one of them before it reaches a customer.
            </p>
          </section>
        </div>

        <div className="space-y-6">
          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-base font-semibold">Needs your approval</h2>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {pending.length} waiting
              </span>
            </div>

            {pending.length === 0 ? (
              <Empty
                title="Nothing waiting on you"
                body="Send a message from the simulator — anything the agent wants to send to a real customer will appear here first."
              />
            ) : (
              <div className="space-y-3">
                {pending.map((task) => (
                  <ApprovalCard key={task.id} task={task} />
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold">Activity</h2>
            {activity.length === 0 ? (
              <Empty title="No activity yet" body="Tasks will appear here as the agent works." />
            ) : (
              <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-2 font-medium">Task</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Units</th>
                      <th className="px-4 py-2 font-medium">When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {activity.map((task) => (
                      <tr key={task.id} className="align-top">
                        <td className="px-4 py-2.5">
                          <p className="font-medium">{TASK_KIND_LABEL[task.kind]}</p>
                          {task.requestText && (
                            <p className="mt-0.5 max-w-md truncate text-xs text-zinc-500 dark:text-zinc-400">
                              “{task.requestText}”
                            </p>
                          )}
                          {task.error && (
                            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                              {task.error}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
                              STATUS_TONE[task.status] ??
                              "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                            }`}
                          >
                            {TASK_STATUS_LABEL[task.status]}
                          </span>
                          {task.status === "failed" && (
                            <div className="mt-1">
                              <RetryButton taskId={task.id} />
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                          {task.isBillable ? task.billableUnits : "—"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-xs text-zinc-500 dark:text-zinc-400">
                          {new Date(task.createdAt).toLocaleString("en-NG", {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-white/50 p-8 text-center dark:border-zinc-700 dark:bg-zinc-900/50">
      <p className="font-medium text-zinc-700 dark:text-zinc-300">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">
        {body}
      </p>
    </div>
  );
}
