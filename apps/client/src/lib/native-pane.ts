/**
 * IPC for the native Bevy pane (`crates-tauri/tt-pane`): a compositor surface
 * above the webview, so CSS can't draw in its rect and its rect must be pushed.
 */

import { invoke } from "@/lib/tauri";
import type { Result } from "better-result";
import type { IpcError } from "@/lib/errors";

/** CSS pixels, relative to the window's client area. */
export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneInfo {
  id: string;
  /** Which platform backend served the pane, e.g. `"wayland"`. */
  backend: string;
  /** Physical pixels — the CSS rect multiplied by the device pixel ratio. */
  width: number;
  height: number;
}

/**
 * Sent with every rect, not read in Rust: `devicePixelRatio` is what laid the
 * placeholder out, and a compositor asked separately can disagree by a step.
 */
const scale = () => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);

export const paneAttach = (id: string, rect: CssRect): Promise<Result<PaneInfo, IpcError>> =>
  invoke<PaneInfo>("pane_attach", { id, rect, scale: scale() });

export const paneSetRect = (id: string, rect: CssRect): Promise<Result<void, IpcError>> =>
  invoke<void>("pane_set_rect", { id, rect, scale: scale() });

export const paneSetVisible = (id: string, visible: boolean): Promise<Result<void, IpcError>> =>
  invoke<void>("pane_set_visible", { id, visible });

export const paneDetach = (id: string): Promise<Result<void, IpcError>> =>
  invoke<void>("pane_detach", { id });

/** True when two rects would place the surface identically. */
export const sameRect = (a: CssRect | null, b: CssRect): boolean =>
  a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * Measure in window-client coordinates — viewport-relative is what the
 * compositor wants, so not `offsetLeft`, which tracks a positioned ancestor.
 */
export const measure = (el: HTMLElement): CssRect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};
