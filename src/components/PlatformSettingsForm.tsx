"use client";

import { useActionState } from "react";
import {
  clearNvidiaKeyAction,
  saveAiSettingsAction,
  saveNvidiaKeyAction,
  type PlatformActionResult,
} from "@/app/admin/platform-actions";

export interface PlatformFormState {
  keySet: boolean;
  keyMasked?: string;
  model: string;
  baseUrl: string;
  thinkingParam: string;
  envBootstrap: boolean;
}

const field =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";

export function PlatformSettingsForm({ initial }: { initial: PlatformFormState }) {
  const [keyState, keyAction, keyPending] = useActionState<
    PlatformActionResult,
    FormData
  >(saveNvidiaKeyAction, { ok: false });

  const [clearState, clearAction, clearPending] = useActionState<
    PlatformActionResult,
    FormData
  >(clearNvidiaKeyAction, { ok: false });

  const [aiState, aiAction, aiPending] = useActionState<
    PlatformActionResult,
    FormData
  >(saveAiSettingsAction, { ok: false });

  // Server state wins over what was rendered, so a save is reflected without a
  // manual reload.
  const keySet = keyState.keySet ?? initial.keySet;

  return (
    <div className="space-y-5">
      {/* ---------------------------------------------------------------- */}
      <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold">NVIDIA API key</h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          Encrypted with AES-256-GCM before it is stored, and never sent back to
          a browser. Only the last four characters are displayable, so that you
          can tell a rotation took effect.
        </p>

        <form action={keyAction} className="mt-4 space-y-3">
          <div>
            <label htmlFor="apiKey" className="mb-1 block text-xs font-medium">
              {keySet ? "Replace key" : "API key"}
            </label>
            <input
              id="apiKey"
              name="apiKey"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={keySet ? `Saved (${initial.keyMasked}) — type to replace` : "nvapi-…"}
              className={field}
            />
          </div>

          <button
            type="submit"
            disabled={keyPending}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {keyPending ? "Saving…" : keySet ? "Replace key" : "Save key"}
          </button>

          {keyState.error && (
            <p className="text-xs text-red-600 dark:text-red-400">{keyState.error}</p>
          )}
          {keyState.ok && (
            <p className="text-xs text-emerald-700 dark:text-emerald-400">
              Key saved. It takes effect on the next assistant reply.
            </p>
          )}
        </form>

        {keySet && (
          <form action={clearAction} className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <button
              type="submit"
              disabled={clearPending}
              className="text-xs font-semibold text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
            >
              {clearPending ? "Clearing…" : "Remove the saved key"}
            </button>
            {clearState.error && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{clearState.error}</p>
            )}
          </form>
        )}

        {initial.envBootstrap && (
          <p className="mt-4 rounded-lg bg-zinc-100 p-3 text-xs leading-relaxed text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            <strong>NVIDIA_API_KEY is also set in the environment.</strong> A saved
            key here takes precedence, which is how rotation works without a
            redeploy. Remove the env var once you are satisfied.
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold">Model</h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          Leave blank to use the built-in default. Run{" "}
          <code className="text-xs">npm run ai:check</code> to list what your key
          can actually reach.
        </p>

        <form action={aiAction} className="mt-4 space-y-3">
          <div>
            <label htmlFor="model" className="mb-1 block text-xs font-medium">
              Model id
            </label>
            <input
              id="model"
              name="model"
              defaultValue={initial.model}
              placeholder="nvidia/llama-3.1-nemotron-70b-instruct"
              spellCheck={false}
              className={field}
            />
          </div>

          <div>
            <label htmlFor="baseUrl" className="mb-1 block text-xs font-medium">
              Base URL <span className="font-normal text-zinc-400">(optional)</span>
            </label>
            <input
              id="baseUrl"
              name="baseUrl"
              defaultValue={initial.baseUrl}
              placeholder="https://integrate.api.nvidia.com/v1"
              spellCheck={false}
              className={field}
            />
            <p className="mt-1 text-xs text-zinc-400">
              Change this to point at a self-hosted NIM container.
            </p>
          </div>

          <div>
            <label htmlFor="thinkingParam" className="mb-1 block text-xs font-medium">
              Thinking kwarg <span className="font-normal text-zinc-400">(optional)</span>
            </label>
            <input
              id="thinkingParam"
              name="thinkingParam"
              defaultValue={initial.thinkingParam}
              placeholder="enable_thinking"
              spellCheck={false}
              className={field}
            />
            <p className="mt-1 text-xs text-zinc-400">
              Sent to disable reasoning when tools are used. The name differs by
              model family: <code className="text-xs">enable_thinking</code> for
              Qwen3/Nemotron, <code className="text-xs">thinking</code> for GLM-style
              templates. A wrong value fails silently — the assistant keeps
              answering but stops calling tools.
            </p>
          </div>

          <button
            type="submit"
            disabled={aiPending}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {aiPending ? "Saving…" : "Save settings"}
          </button>

          {aiState.error && (
            <p className="text-xs text-red-600 dark:text-red-400">{aiState.error}</p>
          )}
          {aiState.ok && (
            <p className="text-xs text-emerald-700 dark:text-emerald-400">Settings saved.</p>
          )}
        </form>
      </section>
    </div>
  );
}