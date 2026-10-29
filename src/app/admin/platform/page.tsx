import { redirect } from "next/navigation";
import { getCurrentActor } from "@/lib/auth/session";
import { logoutAction } from "@/app/auth-actions";
import { isPlatformAdminEmail } from "@/lib/platform/admin";
import {
  describePlatformSecret,
  getPlatformSetting,
} from "@/domain/platform-settings";
import {
  AI_SETTING_BASE_URL,
  AI_SETTING_MODEL,
  AI_SETTING_THINKING_PARAM,
} from "@/ai/index";
import { PlatformSettingsForm, type PlatformFormState } from "@/components/PlatformSettingsForm";
import { AppNav } from "@/components/AppNav";

export const dynamic = "force-dynamic";

export default async function PlatformAdminPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect("/login");

  // Redirect rather than render a 403: a signed-in shop owner has no business
  // knowing this page exists.
  if (!isPlatformAdminEmail(actor.email)) redirect("/");

  const [keyState, model, baseUrl, thinkingParam] = await Promise.all([
    describePlatformSecret("nvidia_api_key"),
    getPlatformSetting(AI_SETTING_MODEL, ""),
    getPlatformSetting(AI_SETTING_BASE_URL, ""),
    getPlatformSetting(AI_SETTING_THINKING_PARAM, ""),
  ]);

  const envBootstrap = Boolean(process.env.NVIDIA_API_KEY);

  const initial: PlatformFormState = {
    keySet: keyState.set,
    keyMasked: keyState.masked,
    model,
    baseUrl,
    thinkingParam,
    envBootstrap,
  };

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold">Platform settings</h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {actor.name} · affects every shop
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm font-medium">{actor.email}</p>
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
        <AppNav current="/admin/platform" />

        <div className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <p className="mb-2 font-medium">This is global, not per shop.</p>
          <p>
            The key below authenticates every message the assistant answers, for
            every tenant. Anyone whose email is in{" "}
            <code className="text-xs">PLATFORM_ADMIN_EMAILS</code> can reach this
            page — keep that list to people you would hand the key to directly.
          </p>
        </div>

        <PlatformSettingsForm initial={initial} />
      </div>
    </div>
  );
}