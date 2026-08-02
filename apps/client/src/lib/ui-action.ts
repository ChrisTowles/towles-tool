import { invoke } from "@/lib/tauri";
import type { ScreenId } from "@/lib/screens";

/** Record one user gesture in the on-disk event log. Discrete intents only: a
 * stable dot-separated action id plus the screen — never content, keystrokes,
 * or continuous input; `detail` is a word of context, not a payload.
 * Fire-and-forget, because a lost record must never block the gesture. */
export function uiAction(action: string, screen: ScreenId, detail?: string): void {
  void invoke<void>("ui_action", { action, screen, detail: detail ?? null });
}
