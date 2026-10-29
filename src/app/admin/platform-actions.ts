"use server";

import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/platform/admin-session";
import {
  AI_SETTING_BASE_URL,
  AI_SETTING_MODEL,
  AI_SETTING_THINKING_PARAM,
} from "@/ai/index";
import {
  clearPlatformSecret,
  setPlatformSecret,
  setPlatformSetting,
} from "@/domain/platform-settings";
import { describePlatformSecret } from "@/domain/platform-settings";

/**
 * Platform settings mutations.
 *
 * Every action re-checks platform-admin access on the server. The page hides
 * the form; this is what actually prevents a tenant owner from posting to it.
 *
 * No action ever returns a stored secret. The UI is told whether one is set and
 * nothing more, so no response body can carry the key.
 */

export interface PlatformActionResult {
  ok: boolean;
  error?: string;
  /** Whether a key is now present. Never the key. */
  keySet?: boolean;
}

export async function saveNvidiaKeyAction(
  _previous: PlatformActionResult,
  formData: FormData,
): Promise<PlatformActionResult> {
  try {
    await requirePlatformAdmin();

    const key = String(formData.get("apiKey") ?? "").trim();
    if (!key) return { ok: false, error: "Enter the API key." };
    if (key.length < 20) {
      return { ok: false, error: "That does not look like an NVIDIA API key." };
    }

    await setPlatformSecret("nvidia_api_key", key);

    revalidatePath("/admin/platform");
    return { ok: true, keySet: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not save the key.",
    };
  }
}

export async function clearNvidiaKeyAction(): Promise<PlatformActionResult> {
  try {
    await requirePlatformAdmin();
    await clearPlatformSecret("nvidia_api_key");

    revalidatePath("/admin/platform");
    return { ok: true, keySet: false };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not clear the key.",
    };
  }
}

export async function saveAiSettingsAction(
  _previous: PlatformActionResult,
  formData: FormData,
): Promise<PlatformActionResult> {
  try {
    await requirePlatformAdmin();

    const model = String(formData.get("model") ?? "").trim();
    const baseUrl = String(formData.get("baseUrl") ?? "").trim();
    const thinkingParam = String(formData.get("thinkingParam") ?? "").trim();

    if (model && model.length > 200) {
      return { ok: false, error: "That model name is implausibly long." };
    }
    // This value is interpolated into the request URL by the adapter, so
    // anything that is not plainly an http(s) origin is refused rather than
    // sanitised. An allowlist beats escaping.
    if (baseUrl && !/^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(baseUrl)) {
      return { ok: false, error: "Base URL must be an http(s) address." };
    }

    await setPlatformSetting(AI_SETTING_MODEL, model);
    await setPlatformSetting(AI_SETTING_BASE_URL, baseUrl);
    await setPlatformSetting(AI_SETTING_THINKING_PARAM, thinkingParam);

    revalidatePath("/admin/platform");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not save settings.",
    };
  }
}

/** Current state for rendering. Reports presence, never the value. */
export async function platformSecretState(key: string) {
  await requirePlatformAdmin();
  return describePlatformSecret(key);
}