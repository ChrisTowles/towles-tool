// Chrome pane IPC + input translation. Mirrors crates-tauri/tt-app/src/browser.rs.
import { Result, Schema } from "effect";
import { NotInTauri, type IpcError } from "@/lib/errors";
import { subscribe } from "@/lib/run";
import { invoke, isTauri, rawChannel, runIpc } from "@/lib/tauri";

const BrowserStateSchema = Schema.Struct({
  paneId: Schema.String,
  phase: Schema.Literals(["launching", "live", "parked", "poppedOut", "crashed"]),
  url: Schema.String,
  title: Schema.String,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  detail: Schema.optional(Schema.NullOr(Schema.String)),
});
export type BrowserState = typeof BrowserStateSchema.Type;

const BrowserStatusSchema = Schema.Struct({
  chromeFound: Schema.Boolean,
  chromePath: Schema.optional(Schema.NullOr(Schema.String)),
});

export const browserStatus = () =>
  runIpc(invoke("browser_status", {}, { schema: BrowserStatusSchema, timeout: 5_000 }));

/** Open and close are serialized per pane: an unmount's fire-and-forget
 * close racing a remount's open would otherwise close the fresh target. */
const paneOps = new Map<string, Promise<unknown>>();

function chained<T>(paneId: string, op: () => Promise<T>): Promise<T> {
  const prev = paneOps.get(paneId) ?? Promise.resolve();
  const next = prev.then(op, op);
  paneOps.set(
    paneId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export async function browserOpen(
  paneId: string,
  url: string | undefined,
  onFrame: (f: Uint8Array) => void,
): Promise<Result.Result<unknown, IpcError>> {
  if (!isTauri()) return Result.fail(new NotInTauri({ command: "browser_open" }));
  const channel = await rawChannel(onFrame);
  return chained(paneId, () =>
    runIpc(invoke("browser_open", { paneId, url, onFrame: channel }, { timeout: 30_000 })),
  );
}

export const browserNavigate = (
  paneId: string,
  to: { url?: string; action?: "back" | "forward" | "reload" },
) => runIpc(invoke("browser_navigate", { paneId, url: to.url, action: to.action }));

export const browserInput = (paneId: string, events: BrowserInputEvent[]) =>
  runIpc(invoke("browser_input", { paneId, events }));

export const browserSetViewport = (paneId: string, width: number, height: number, dpr: number) =>
  chained(paneId, () => runIpc(invoke("browser_set_viewport", { paneId, width, height, dpr })));

export const browserSetVisible = (paneId: string, visible: boolean) =>
  chained(paneId, () => runIpc(invoke("browser_set_visible", { paneId, visible })));

export const browserCapture = (paneId: string) =>
  runIpc(invoke<string>("browser_capture", { paneId }, { timeout: 15_000 }));

export const browserClose = (paneId: string) =>
  chained(paneId, () => runIpc(invoke("browser_close", { paneId })));

export const browserPopout = (paneId: string) => runIpc(invoke("browser_popout", { paneId }));

/** Subscribe to `browser://state`; unexpected payloads are logged and dropped. */
export const subscribeBrowserState = (handler: (state: BrowserState) => void): (() => void) =>
  subscribe("browser://state", handler, BrowserStateSchema);

// Input translation — pure, unit-tested. Shapes mirror `translate_input` in
// browser.rs, which allowlists them before dispatching to CDP.

export type BrowserInputEvent =
  | {
      kind: "mouse";
      type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
      x: number;
      y: number;
      button?: "left" | "middle" | "right";
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers: number;
    }
  | {
      kind: "key";
      type: "keyDown" | "keyUp" | "char";
      key: string;
      code: string;
      text?: string;
      windowsVirtualKeyCode?: number;
      nativeVirtualKeyCode?: number;
      modifiers: number;
    };

type ModifierBits = { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function cdpModifiers(e: ModifierBits): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const CDP_BUTTONS = ["left", "middle", "right"] as const;

/** `scale` maps pane-local CSS px into page CSS px — the two differ whenever
 * a resize hasn't reached Chrome yet, and a mismatch means missed clicks. */
export type PaneOrigin = { left: number; top: number; scaleX?: number; scaleY?: number };

export function mouseEvent(
  type: "mousePressed" | "mouseReleased" | "mouseMoved",
  e: ModifierBits & { button: number; clientX: number; clientY: number; detail?: number },
  origin: PaneOrigin,
): BrowserInputEvent {
  return {
    kind: "mouse",
    type,
    x: (e.clientX - origin.left) * (origin.scaleX ?? 1),
    y: (e.clientY - origin.top) * (origin.scaleY ?? 1),
    button: CDP_BUTTONS[e.button] ?? "left",
    clickCount: type === "mouseMoved" ? undefined : Math.max(1, e.detail ?? 1),
    modifiers: cdpModifiers(e),
  };
}

export function wheelEvent(
  e: ModifierBits & { clientX: number; clientY: number; deltaX: number; deltaY: number },
  origin: PaneOrigin,
): BrowserInputEvent {
  return {
    kind: "mouse",
    type: "mouseWheel",
    x: (e.clientX - origin.left) * (origin.scaleX ?? 1),
    y: (e.clientY - origin.top) * (origin.scaleY ?? 1),
    // The wheel scrolls content down when deltaY is positive; CDP's sign is
    // the scroll offset delta, i.e. inverted from the DOM's.
    deltaX: -e.deltaX,
    deltaY: -e.deltaY,
    modifiers: cdpModifiers(e),
  };
}

const VKEYS: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

const KEY_TEXT: Record<string, string> = { Enter: "\r", Tab: "\t" };

/** One DOM key event → the CDP events it implies (keyDown carries the text
 * that produces the character; keyUp carries none). */
export function keyEvents(
  direction: "down" | "up",
  e: ModifierBits & { key: string; code: string },
): BrowserInputEvent[] {
  const printable = e.key.length === 1;
  const text = direction === "down" ? (printable ? e.key : KEY_TEXT[e.key]) : undefined;
  const vkey = VKEYS[e.key] ?? (printable ? e.key.toUpperCase().charCodeAt(0) : undefined);
  return [
    {
      kind: "key",
      type: direction === "down" ? "keyDown" : "keyUp",
      key: e.key,
      code: e.code,
      ...(text !== undefined && { text }),
      ...(vkey !== undefined && { windowsVirtualKeyCode: vkey, nativeVirtualKeyCode: vkey }),
      modifiers: cdpModifiers(e),
    },
  ];
}

/** Scheme-less input gets http://, matching the preview pane's URL field.
 * The scheme list is explicit because `localhost:3000` parses as a scheme. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  return /^(https?|file|data|about|chrome):/i.test(trimmed) ? trimmed : `http://${trimmed}`;
}
