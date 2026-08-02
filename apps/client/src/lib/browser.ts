// Chrome pane IPC + input translation. Mirrors crates-tauri/tt-app/src/browser.rs.
import { Result } from "better-result";
import { z } from "zod";
import { NotInTauri, type IpcError } from "@/lib/errors";
import { invoke, isTauri, rawChannel } from "@/lib/tauri";

const BrowserStateSchema = z.object({
  paneId: z.string(),
  phase: z.enum(["launching", "live", "parked", "poppedOut", "crashed"]),
  url: z.string(),
  title: z.string(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  detail: z.string().nullish(),
});
export type BrowserState = z.infer<typeof BrowserStateSchema>;

const BrowserStatusSchema = z.object({
  chromeFound: z.boolean(),
  chromePath: z.string().nullish(),
});
export type BrowserStatus = z.infer<typeof BrowserStatusSchema>;

export const browserStatus = () =>
  invoke("browser_status", {}, { schema: BrowserStatusSchema, timeoutMs: 5_000 });

export async function browserOpen(
  paneId: string,
  url: string | undefined,
  onFrame: (f: Uint8Array) => void,
): Promise<Result<unknown, IpcError>> {
  if (!isTauri()) return Result.err(new NotInTauri({ command: "browser_open" }));
  const channel = await rawChannel(onFrame);
  return invoke("browser_open", { paneId, url, onFrame: channel }, { timeoutMs: 30_000 });
}

export const browserNavigate = (
  paneId: string,
  to: { url?: string; action?: "back" | "forward" | "reload" },
) => invoke("browser_navigate", { paneId, url: to.url, action: to.action });

export const browserInput = (paneId: string, events: BrowserInputEvent[]) =>
  invoke("browser_input", { paneId, events });

export const browserSetViewport = (paneId: string, width: number, height: number, dpr: number) =>
  invoke("browser_set_viewport", { paneId, width, height, dpr });

export const browserSetVisible = (paneId: string, visible: boolean) =>
  invoke("browser_set_visible", { paneId, visible });

export const browserCapture = (paneId: string) =>
  invoke<string>("browser_capture", { paneId }, { timeoutMs: 15_000 });

export const browserClose = (paneId: string) => invoke("browser_close", { paneId });

export const browserPopout = (paneId: string) => invoke("browser_popout", { paneId });

/** Subscribe to `browser://state`; unexpected payloads are logged and dropped. */
export function subscribeBrowserState(handler: (state: BrowserState) => void): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const sub = await listen<unknown>("browser://state", (event) => {
      const parsed = BrowserStateSchema.safeParse(event.payload);
      if (parsed.success) handler(parsed.data);
      else console.error("browser://state: unexpected payload", parsed.error.issues);
    });
    if (disposed) sub();
    else unlisten = sub;
  })();
  return () => {
    disposed = true;
    unlisten?.();
  };
}

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

export function mouseEvent(
  type: "mousePressed" | "mouseReleased" | "mouseMoved",
  e: ModifierBits & { button: number; clientX: number; clientY: number; detail?: number },
  origin: { left: number; top: number },
): BrowserInputEvent {
  return {
    kind: "mouse",
    type,
    x: e.clientX - origin.left,
    y: e.clientY - origin.top,
    button: CDP_BUTTONS[e.button] ?? "left",
    clickCount: type === "mouseMoved" ? undefined : Math.max(1, e.detail ?? 1),
    modifiers: cdpModifiers(e),
  };
}

export function wheelEvent(
  e: ModifierBits & { clientX: number; clientY: number; deltaX: number; deltaY: number },
  origin: { left: number; top: number },
): BrowserInputEvent {
  return {
    kind: "mouse",
    type: "mouseWheel",
    x: e.clientX - origin.left,
    y: e.clientY - origin.top,
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
