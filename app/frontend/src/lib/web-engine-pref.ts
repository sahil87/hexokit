/**
 * The per-viewer web-engine preference and the selection rule the chrome and
 * the palette share. The flag is localStorage state (Constitution IV —
 * per-viewer, never POSTed, not a settings-registry key); React consumers
 * read and write it through `useLocalStorageBoolean` (the same-tab pub/sub
 * keeps the chrome and the palette entry in sync without a reload). This
 * module is the non-React half: the storage key, the default, a try/catch
 * read, and the pure selection rule.
 */

import type { WebFrameEngineKind } from "@/lib/web-frame-engine";

/** localStorage key for the per-viewer engine preference. `"true"` (or absent
 *  — the default) selects the native engine when the shell offers it;
 *  `"false"` keeps the iframe engine. Per-viewer state (Constitution IV),
 *  never POSTed, not a settings-registry key. */
export const WEB_NATIVE_ENGINE_PREF_KEY = "hexokit-web-native-engine";
export const WEB_NATIVE_ENGINE_DEFAULT = true;

/** Non-React read (try/catch; absent or unreadable ⇒ the default). */
export function readNativeEnginePref(): boolean {
  try {
    const stored = localStorage.getItem(WEB_NATIVE_ENGINE_PREF_KEY);
    if (stored === "false") return false;
    if (stored === "true") return true;
  } catch {
    // localStorage unavailable (SSR, privacy mode, sandboxed iframe)
  }
  return WEB_NATIVE_ENGINE_DEFAULT;
}

/** THE selection rule — bridge presence × viewer preference. Pure so both the
 *  chrome and the palette builder share one answer. */
export function selectWebEngineKind(
  shellWeb: boolean,
  nativeEnabled: boolean,
): WebFrameEngineKind {
  return shellWeb && nativeEnabled ? "native" : "iframe";
}
