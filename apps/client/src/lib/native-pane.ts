/**
 * Wire types and IPC for the native Bevy pane (`crates-tauri/tt-pane`).
 *
 * The pane is a real compositor surface over a rectangle of the window, which
 * gives it two properties every call site inherits:
 *
 * 1. **CSS does not reach it.** It sits above the webview, so anything the DOM
 *    draws inside its rect is invisible — hide the pane to show something
 *    there. Hiding parks the surface off screen rather than unmapping it, for
 *    reasons worth knowing before you touch it (`crates-tauri/tt-pane`).
 * 2. **Its position is pushed, not declared.** Measure the placeholder, send
 *    the rect; the two stay aligned only for as long as something keeps
 *    pushing.
 *
 * Pure module — no React, no DOM rendering.
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
 * Scale is sent alongside every rect rather than being read in Rust.
 *
 * The webview's `devicePixelRatio` is the number that actually governs how the
 * DOM laid the placeholder out, so it is the only value guaranteed to keep the
 * surface aligned with it. Asking the compositor separately invites a
 * disagreement of one scale step on fractional scaling, which shows as a seam.
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
 * Measure an element in window-client coordinates.
 *
 * `getBoundingClientRect` is already relative to the viewport, which is what
 * the compositor wants — no scroll offset correction, and deliberately not
 * `offsetLeft`/`offsetParent`, which would be relative to whatever ancestor
 * happens to be positioned.
 */
export const measure = (el: HTMLElement): CssRect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};
