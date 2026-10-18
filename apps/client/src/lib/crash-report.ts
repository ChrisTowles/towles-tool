import { fire, invoke } from "@/lib/tauri";
import { isKnownBenignEntry } from "@/lib/wdio-console";

/** The WebView half of crash capture: uncaught errors and unhandled rejections
 * go to `crash_report`, which writes the same `app.crash` event a Rust panic
 * does. The Doctor screen lists them. */

type CrashKind = "webview-error" | "unhandled-rejection";

export type CrashReport = {
  kind: CrashKind;
  message: string;
  location: string | null;
  stack: string | null;
};

/** A render loop can throw thousands a second; the log needs the first few. */
const MAX_PER_SESSION = 20;
const REPEAT_WINDOW_MS = 60_000;

/** Drops repeats inside a minute and stops after a session's worth, so a crash
 * loop costs a few lines of log rather than the day's file. */
export function crashGate(now: () => number = Date.now) {
  const lastSeen = new Map<string, number>();
  let sent = 0;
  return (report: CrashReport): boolean => {
    if (sent >= MAX_PER_SESSION) return false;
    const key = `${report.kind}:${report.message}`;
    const at = now();
    const prev = lastSeen.get(key);
    lastSeen.set(key, at);
    if (prev !== undefined && at - prev < REPEAT_WINDOW_MS) return false;
    sent += 1;
    return true;
  };
}

function reportOfError(e: ErrorEvent): CrashReport {
  const err: unknown = e.error;
  return {
    kind: "webview-error",
    message: e.message || (err instanceof Error ? err.message : "unknown error"),
    location: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : null,
    stack: err instanceof Error ? (err.stack ?? null) : null,
  };
}

export function reportOfRejection(reason: unknown): CrashReport {
  if (reason instanceof Error) {
    return {
      kind: "unhandled-rejection",
      message: `${reason.name}: ${reason.message}`,
      location: null,
      stack: reason.stack ?? null,
    };
  }
  let message = String(reason);
  if (typeof reason === "string") message = reason;
  else {
    try {
      // `undefined` and functions stringify to `undefined`, not a string.
      message = (JSON.stringify(reason) as string | undefined) ?? message;
    } catch {
      // A cycle: `String` already gave the best this reason has.
    }
  }
  return { kind: "unhandled-rejection", message, location: null, stack: null };
}

/** Install once, before the first render, so a crash during it is caught. */
export function installCrashReporter() {
  const allow = crashGate();
  const send = (report: CrashReport) => {
    if (!allow(report)) return;
    fire(invoke("crash_report", report));
  };
  window.addEventListener("error", (e) => send(reportOfError(e)));
  window.addEventListener("unhandledrejection", (e) => {
    const report = reportOfRejection(e.reason);
    if (isKnownBenignEntry("rejection", report.message)) return;
    send(report);
  });
}
