/**
 * IPC for the native Bevy pane (`crates-tauri/tt-pane`): a compositor surface
 * above the webview, so CSS can't draw in its rect and its rect must be pushed.
 */

import { invoke, runIpc } from "@/lib/tauri";
import type { Result } from "effect";
import type { IpcError } from "@/lib/errors";

export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneInfo {
  id: string;
  backend: string;
  width: number;
  height: number;
}

/**
 * Sent with every rect, not read in Rust: `devicePixelRatio` is what laid the
 * placeholder out, and a compositor asked separately can disagree by a step.
 */
const scale = () => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);

export const paneAttach = (id: string, rect: CssRect): Promise<Result.Result<PaneInfo, IpcError>> =>
  runIpc(invoke<PaneInfo>("pane_attach", { id, rect, scale: scale() }));

export const paneSetRect = (id: string, rect: CssRect): Promise<Result.Result<void, IpcError>> =>
  runIpc(invoke<void>("pane_set_rect", { id, rect, scale: scale() }));

export const paneSetVisible = (
  id: string,
  visible: boolean,
): Promise<Result.Result<void, IpcError>> =>
  runIpc(invoke<void>("pane_set_visible", { id, visible }));

export const paneDetach = (id: string): Promise<Result.Result<void, IpcError>> =>
  runIpc(invoke<void>("pane_detach", { id }));

export const sameRect = (a: CssRect | null, b: CssRect): boolean =>
  a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export const measure = (el: HTMLElement): CssRect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};
