/** E2E/live-drive only: buffer console errors and uncaught exceptions on
 * `window` for the out-of-process harness. Installed synchronously before
 * `createRoot` — a dynamic import would miss the first render's warnings. */

/** Cross-process contract with `scripts/drive.mjs`'s `CONSOLE_KEY`; renaming
 * one side silently disables the check rather than failing. */
export const WDIO_CONSOLE_KEY = "__ttConsoleErrors";

const MAX_ENTRIES = 200;

export type CapturedConsoleEntry = {
  kind: "error" | "warn" | "exception" | "rejection";
  text: string;
  at: number;
};

/** Two harness-init warnings and one Tauri-core unlisten-race rejection
 * (tauri-apps/tauri#8916) — none describe an app problem, and buffering them
 * was pure alert fatigue. Matched narrowly so a real failure still lands. */
const KNOWN_BENIGN_WARNS = [
  "TEST: This is a test WARN log after setupConsoleForwarding()",
  "Invoke interception via defineProperty failed",
] as const;

const TAURI_UNLISTEN_RACE =
  /^TypeError: undefined is not an object \(evaluating 'listeners\[eventId\]\.handlerId'\)/;

export function isKnownBenignEntry(kind: CapturedConsoleEntry["kind"], text: string): boolean {
  if (kind === "warn") return KNOWN_BENIGN_WARNS.some((needle) => text.includes(needle));
  if (kind === "rejection") return TAURI_UNLISTEN_RACE.test(text);
  return false;
}

function render(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    const frames = value.stack?.split("\n").slice(0, 4).join(" ← ");
    return frames
      ? `${value.name}: ${value.message} [${frames}]`
      : `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export function installConsoleCollector(): void {
  const win = window as unknown as Record<string, unknown>;
  // Idempotent — a hot reload must not stack wrappers around console.error.
  if (win[WDIO_CONSOLE_KEY]) return;

  const buffer: CapturedConsoleEntry[] = [];
  win[WDIO_CONSOLE_KEY] = buffer;

  const push = (kind: CapturedConsoleEntry["kind"], text: string) => {
    if (isKnownBenignEntry(kind, text)) return;
    if (buffer.length >= MAX_ENTRIES) buffer.shift();
    buffer.push({ kind, text: text.slice(0, 2000), at: Date.now() });
  };

  for (const kind of ["error", "warn"] as const) {
    const original = console[kind].bind(console);
    console[kind] = (...args: unknown[]) => {
      push(kind, args.map(render).join(" "));
      original(...args);
    };
  }

  window.addEventListener("error", (e) => {
    push("exception", e.message ? `${e.message} (${e.filename}:${e.lineno})` : "unknown error");
  });
  window.addEventListener("unhandledrejection", (e) => {
    push("rejection", render(e.reason));
  });
}
