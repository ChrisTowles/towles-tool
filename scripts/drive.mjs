#!/usr/bin/env node
// Live-drive the window opened by `bun run dev:drive` — plain fetch against the
// in-app W3C WebDriver server, NO @wdio/* import at runtime. Reads and IPC go
// through the session-less `POST /wdio/eval`; shot/click/type/url each open a
// short-lived session, or reuse one passed as `--session` (see `session-open`).
// Run with no verb for the verb list. Ports come from the rendered `.env`.
import { writeFile, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Result } from "better-result";
import { RemoteRejected, RequestFailed, SpawnFailed } from "./errors.mjs";
import { requireDevPort, resolveWebdriverPort } from "./task-port.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

const devPort = requireDevPort(repoRoot, { tag: "drive" });
const wdPort = resolveWebdriverPort(devPort);
const base = `http://127.0.0.1:${wdPort}`;

/** @typedef {RequestFailed | RemoteRejected | SpawnFailed} DriveError */

/** `json` is the parsed body, or `{ raw }` when the server sent non-JSON.
 * @typedef {{ status: number; ok: boolean; json: Record<string, unknown> }} HttpResponse */

/** The CLI's terminal boundary — every internal seam returns a Result instead.
 * @param {string} msg @returns {never} */
function fail(msg) {
  console.error(`[drive] ${msg}`);
  process.exit(1);
}

/** @param {DriveError} error @returns {never} */
function failWith(error) {
  return fail(error.message);
}

/** WebDriver payloads differ per endpoint, so responses are narrowed field by
 * field rather than trusted wholesale.
 * @param {unknown} value @param {string} key @returns {unknown} */
function prop(value, key) {
  if (typeof value !== "object" || value === null) return undefined;
  return /** @type {Record<string, unknown>} */ (value)[key];
}

/** Never throws. A non-2xx response is still an `Ok` carrying `ok: false` —
 * endpoints differ on which statuses matter, so the caller judges, not this.
 * @param {string} method @param {string} pathname @param {unknown} [body]
 * @returns {Promise<Result<HttpResponse, RequestFailed>>} */
async function http(method, pathname, body) {
  const url = base + pathname;
  const sent = await Result.tryPromise({
    try: () =>
      fetch(url, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    catch: (e) => new RequestFailed({ url, base, cause: e }),
  });
  if (sent.isErr()) return Result.err(sent.error);

  const res = sent.value;
  const text = await res.text();
  /** @type {Record<string, unknown>} */
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return Result.ok({ status: res.status, ok: res.ok, json });
}

/** `http` plus the check almost every caller wants: a non-2xx status or a
 * WebDriver `error` field becomes a {@link RemoteRejected} naming `action`.
 * @param {string} action @param {string} method
 * @param {string} pathname @param {unknown} [body]
 * @returns {Promise<Result<Record<string, unknown>, DriveError>>} */
async function request(action, method, pathname, body) {
  const sent = await http(method, pathname, body);
  if (sent.isErr()) return Result.err(sent.error);
  const { ok, status, json } = sent.value;
  if (!ok) {
    const detail = json.error === undefined ? `HTTP ${status}` : JSON.stringify(json);
    return Result.err(new RemoteRejected({ action, detail }));
  }
  return Result.ok(json);
}

// session-less eval (reads + IPC). The executor appends the W3C async done
// callback as the last argument, so the script reports through it in the
// {ok, value, undef} shape /wdio/eval expects.
/** @param {string} expr @returns {string} */
function wrapExpr(expr) {
  return `var __cb = arguments[arguments.length - 1];
(async () => {
  try {
    const __r = await (${expr});
    __cb({ ok: true, value: __r === undefined ? null : __r, undef: __r === undefined });
  } catch (e) {
    __cb({ ok: false, error: (e && e.message) || String(e) });
  }
})();`;
}

/** The value is `unknown` by construction — it crossed a process boundary as
 * JSON — so callers narrow it rather than assuming a shape.
 * @param {string} expr @returns {Promise<Result<unknown, DriveError>>} */
async function evalExpr(expr) {
  const sent = await request("eval failed", "POST", "/wdio/eval", { script: wrapExpr(expr) });
  if (sent.isErr()) return Result.err(sent.error);
  const json = sent.value;
  if (json.error !== undefined) {
    return Result.err(new RemoteRejected({ action: "eval failed", detail: String(json.error) }));
  }
  return Result.ok(json.undef === true ? undefined : json.value);
}

// W3C session (screenshots, clicks, nav). Each call opens and tears down its
// own unless `--session <id>` passes in a caller-managed one.
/** @returns {Promise<Result<string, DriveError>>} */
async function createSession() {
  const action = "could not create a WebDriver session";
  const created = await request(action, "POST", "/session", { capabilities: { alwaysMatch: {} } });
  if (created.isErr()) return Result.err(created.error);
  const sessionId = prop(created.value.value, "sessionId");
  if (typeof sessionId !== "string" || !sessionId) {
    return Result.err(new RemoteRejected({ action, detail: JSON.stringify(created.value) }));
  }
  return Result.ok(sessionId);
}

/** @template T
 * @param {(sessionId: string) => Promise<Result<T, DriveError>>} fn
 * @param {string | null} [existingSessionId]
 * @returns {Promise<Result<T, DriveError>>} */
async function withSession(fn, existingSessionId) {
  if (existingSessionId) return fn(existingSessionId);
  const created = await createSession();
  if (created.isErr()) return Result.err(created.error);
  const sessionId = created.value;
  try {
    return await fn(sessionId);
  } finally {
    // Best-effort: a failure here must not mask the caller's own outcome.
    await http("DELETE", `/session/${sessionId}`);
  }
}

/** Pulls `--session <id>` from anywhere in a verb's args, so it can be appended
 * to shot/click/type/url without disturbing their positionals.
 * @param {string[]} args @returns {{ session: string | null; rest: string[] }} */
function extractSessionFlag(args) {
  const idx = args.indexOf("--session");
  if (idx === -1) return { session: null, rest: args };
  const session = args[idx + 1];
  if (!session) fail(`--session requires a session id (from \`session-open\`)`);
  return { session, rest: [...args.slice(0, idx), ...args.slice(idx + 2)] };
}

/** A full event sequence rather than the native W3C click endpoint: that one
 * fires something Radix `DropdownMenu`/`Popover` triggers don't react to, so
 * `DismissableLayer` never flips `data-state` to `open` (#35).
 * @param {string} sessionId @param {string} elId
 * @returns {Promise<Result<void, DriveError>>} */
async function dispatchClick(sessionId, elId) {
  const script = `
    const el = arguments[0];
    const opts = { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.focus();
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  `;
  const sent = await request(
    "click dispatch failed",
    "POST",
    `/session/${sessionId}/execute/sync`,
    { script, args: [{ [ELEMENT_KEY]: elId }] },
  );
  return sent.map(() => undefined);
}

/** @param {string} sessionId @param {string} selector
 * @returns {Promise<Result<string, DriveError>>} */
async function findElement(sessionId, selector) {
  const action = `no element matched \`${selector}\``;
  const sent = await request(action, "POST", `/session/${sessionId}/element`, {
    using: "css selector",
    value: selector,
  });
  if (sent.isErr()) return Result.err(sent.error);
  const elId = prop(sent.value.value, ELEMENT_KEY);
  if (typeof elId !== "string" || !elId) {
    return Result.err(new RemoteRejected({ action, detail: JSON.stringify(sent.value) }));
  }
  return Result.ok(elId);
}

/** @param {unknown} v @returns {string} */
function fmt(v) {
  if (v === undefined) return "(undefined)";
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

// Where the app buffers console.error/warn + uncaught exceptions under VITE_WDIO
// (apps/client/src/lib/wdio-console.ts). A cross-process contract: rename either
// side and this check just goes quiet. Without it React's runtime complaints
// only reach the `dev:drive` terminal, a different process from this script.
const CONSOLE_KEY = "__ttConsoleErrors";

/** @typedef {{ kind: string; text: string; at: number }} ConsoleEntry */

/** Inert defaults, so a malformed record can't crash the reporter.
 * @param {unknown} raw @returns {ConsoleEntry} */
function toConsoleEntry(raw) {
  const kind = prop(raw, "kind");
  const text = prop(raw, "text");
  const at = prop(raw, "at");
  return {
    kind: typeof kind === "string" ? kind : "error",
    text: typeof text === "string" ? text : String(text),
    at: typeof at === "number" ? at : 0,
  };
}

/** `null` = no collector in the page (not a VITE_WDIO build).
 * @param {{ clear?: boolean }} [opts]
 * @returns {Promise<Result<ConsoleEntry[] | null, DriveError>>} */
async function readConsole({ clear = false } = {}) {
  const read = await evalExpr(`(() => {
    const b = window[${JSON.stringify(CONSOLE_KEY)}];
    if (!b) return null;
    const out = b.slice();
    if (${clear}) b.length = 0;
    return out;
  })()`);
  return read.map((raw) => (Array.isArray(raw) ? raw.map(toConsoleEntry) : null));
}

/** Count + last few only: the buffer holds up to 200 × 2KB entries.
 * @returns {Promise<Result<{ count: number; last: ConsoleEntry[] } | null, DriveError>>} */
async function readConsoleSummary() {
  const read = await evalExpr(`(() => {
    const b = window[${JSON.stringify(CONSOLE_KEY)}];
    if (!b) return null;
    const errors = b.filter((e) => e.kind !== "warn");
    return { count: errors.length, last: errors.slice(-3) };
  })()`);
  return read.map((raw) => {
    const count = prop(raw, "count");
    if (typeof count !== "number") return null;
    const last = prop(raw, "last");
    return { count, last: Array.isArray(last) ? last.map(toConsoleEntry) : [] };
  });
}

/** Runs after every verb, so a broken render is impossible to miss even when
 * the verb itself succeeded. */
async function surfaceConsoleErrors() {
  const read = await readConsoleSummary();
  // Never let the check itself break a working command.
  if (read.isErr()) return;
  const found = read.value;
  if (!found || found.count === 0) return;
  console.error(
    `\n[drive] ⚠ ${found.count} console error(s) in the page — run \`drive.mjs console\` for detail:`,
  );
  for (const e of found.last) {
    console.error(`  [${e.kind}] ${e.text.split("\n")[0].slice(0, 160)}`);
  }
}

const execFileAsync = promisify(execFile);

/** A non-zero exit and a missing binary are the same kind of answer here —
 * neither should be a thrown `unknown` mid-verb.
 * @param {string} cmd @param {string[]} args
 * @returns {Promise<import("better-result").Result<string, SpawnFailed>>} */
async function run(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args);
    return Result.ok(stdout.trim());
  } catch (cause) {
    return Result.err(new SpawnFailed({ command: `${cmd} ${args.join(" ")}`, cause }));
  }
}

/** Whole-window compositor shot: `shot` captures the webview, which cannot see a
 * `tt-pane` (a Wayland subsurface above it). Fullscreening on the test monitor
 * first picks this window out of a whole-desktop capture *and* forces it
 * unoccluded — a vsync-paced pane photographs stale otherwise.
 * @param {string} name @returns {Promise<import("better-result").Result<{file: string; rect: Record<string, unknown>}, DriveError | SpawnFailed>>} */
async function captureWindow(name) {
  const placed = await evalExpr(
    `window.__TAURI_INTERNALS__.invoke("wdio_place_on_test_monitor", { fullscreen: true })`,
  );
  if (placed.isErr()) return placed;
  const rect = /** @type {Record<string, unknown>} */ (placed.value);
  const [x, y, w, h] = [rect.x, rect.y, rect.width, rect.height];
  if ([x, y, w, h].some((v) => typeof v !== "number")) {
    return Result.err(
      new RemoteRejected({ action: "place window", detail: JSON.stringify(rect) }),
    );
  }
  // A native pane needs a few frame callbacks after the fullscreen round-trip;
  // capturing early is the failure that looks like "the pane renders nothing".
  await new Promise((r) => setTimeout(r, 1200));

  const tmp = path.join(os.tmpdir(), `tt-winshot-${process.pid}`);
  await mkdir(tmp, { recursive: true });
  try {
    const shot = await run("cosmic-screenshot", ["--interactive=false", "--save-dir", tmp]);
    if (shot.isErr()) return shot;
    const desktop = shot.value.split("\n").pop() ?? "";
    const dir = path.join(repoRoot, "e2e/screenshots");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    const cropped = await run("convert", [
      desktop,
      "-crop",
      `${w}x${h}+${x}+${y}`,
      "+repage",
      file,
    ]);
    if (cropped.isErr()) return cropped;
    return Result.ok({ file, rect });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** @param {number} exitCode @returns {never} */
function usage(exitCode) {
  console.log(
    [
      "Live-drive the window opened by `bun run dev:drive`.",
      "",
      "  status                     is the automation server up?",
      '  eval "<js expression>"     run JS in the live window, print the result',
      "  invoke <cmd> [jsonArgs]    call a real Rust IPC command",
      "  shot <name> [--session id]     screenshot → e2e/screenshots/<name>.png",
      "  winshot <name>             whole-window compositor shot (sees native panes;",
      "                             fullscreens on the test monitor first)",
      "  unplace                    restore the window from `winshot`'s fullscreen",
      '  click "<css selector>" [--session id]   click an element in the shared window',
      '  clicktext "<text>"         click a button/link by its visible text',
      '  type "<css selector>" <text> [--session id]   type into an element',
      "  url <path> [--session id]  navigate the window",
      "  session-open               open a session that outlives one command, print its id",
      "  session-close <id>         close a session opened with session-open",
      "  console [--clear]          console errors/warnings the page has logged",
      "",
      "Every verb also prints a ⚠ summary when the page has logged errors —",
      "React reports invalid markup at runtime, and nothing else here sees it.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

// verbs
const [verb, ...rest] = process.argv.slice(2);

switch (verb) {
  case "status": {
    const sent = await http("GET", "/status");
    if (sent.isErr()) failWith(sent.error);
    const { json } = sent.value;
    const payload = json.value ?? json;
    console.log(fmt(payload));
    process.exit(prop(payload, "ready") ? 0 : 1);
    break;
  }
  case "eval": {
    const expr = rest.join(" ");
    if (!expr) fail(`usage: drive.mjs eval "<js expression>"`);
    console.log(fmt((await evalExpr(expr)).match({ ok: (v) => v, err: failWith })));
    break;
  }
  case "invoke": {
    const [cmd, argsJson] = rest;
    if (!cmd) fail(`usage: drive.mjs invoke <command> [jsonArgs]`);
    const args = argsJson ?? "{}";
    try {
      JSON.parse(args);
    } catch {
      fail(`invalid JSON args: ${argsJson}`);
    }
    const expr = `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${args})`;
    console.log(fmt((await evalExpr(expr)).match({ ok: (v) => v, err: failWith })));
    break;
  }
  case "session-open": {
    const created = await createSession();
    if (created.isErr()) failWith(created.error);
    console.log(created.value);
    break;
  }
  case "session-close": {
    const sessionId = rest[0];
    if (!sessionId) fail(`usage: drive.mjs session-close <id>`);
    const closed = await request("session-close failed", "DELETE", `/session/${sessionId}`);
    if (closed.isErr()) failWith(closed.error);
    console.log(`closed session ${sessionId}`);
    break;
  }
  case "shot": {
    const { session, rest: args } = extractSessionFlag(rest);
    const name = (args[0] || "shot").replace(/[^\w.-]/g, "_");
    const dir = path.join(repoRoot, "e2e/screenshots");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    const shot = await withSession(async (s) => {
      const action = "screenshot failed";
      const sent = await request(action, "GET", `/session/${s}/screenshot`);
      if (sent.isErr()) return Result.err(sent.error);
      const b64 = sent.value.value;
      if (typeof b64 !== "string" || !b64) {
        return Result.err(new RemoteRejected({ action, detail: JSON.stringify(sent.value) }));
      }
      return Result.ok(b64);
    }, session);
    if (shot.isErr()) failWith(shot.error);
    await writeFile(file, Buffer.from(shot.value, "base64"));
    console.log(file);
    break;
  }
  case "click": {
    const { session, rest: args } = extractSessionFlag(rest);
    const sel = args.join(" ");
    if (!sel) fail(`usage: drive.mjs click "<css selector>" [--session id]`);
    const clicked = await withSession(
      (s) => findElement(s, sel).then((el) => el.andThenAsync((id) => dispatchClick(s, id))),
      session,
    );
    if (clicked.isErr()) failWith(clicked.error);
    console.log(`clicked ${sel}`);
    break;
  }
  case "clicktext": {
    const text = rest.join(" ").trim();
    if (!text) fail(`usage: drive.mjs clicktext "<visible text>"`);
    // Structured result, so ambiguous/missing text can report the candidates.
    const clicked = await evalExpr(`(() => {
      const target = ${JSON.stringify(text)};
      const sel = 'button, a, [role=button], [role=link], [role=menuitem],' +
        ' [role=menuitemradio], [role=tab], [role=option], summary,' +
        ' input[type=button], input[type=submit], input[type=reset]';
      const nodes = Array.from(document.querySelectorAll(sel));
      const label = (n) => ((n.innerText ?? n.value ?? n.textContent ?? '') + '').trim();
      const matches = nodes.filter((n) => label(n) === target);
      if (matches.length === 1) {
        matches[0].click();
        return { clicked: true };
      }
      const candidates = [...new Set(nodes.map(label).filter(Boolean))].sort();
      if (matches.length === 0) return { clicked: false, reason: 'none', candidates };
      return { clicked: false, reason: 'ambiguous', count: matches.length, candidates };
    })()`);
    if (clicked.isErr()) failWith(clicked.error);
    const result = clicked.value;
    if (prop(result, "clicked") !== true) {
      const raw = prop(result, "candidates");
      const candidates = Array.isArray(raw) ? raw.map(String) : [];
      const list = candidates.map((c) => `  - ${c}`).join("\n");
      if (prop(result, "reason") === "ambiguous") {
        fail(
          `\`${text}\` matched ${prop(result, "count")} clickable elements (ambiguous).\n` +
            `Clickable texts found:\n${list}`,
        );
      }
      fail(
        `no clickable element with visible text \`${text}\`.\n` +
          `Clickable texts found:\n${list || "  (none)"}`,
      );
    }
    console.log(`clicked "${text}"`);
    break;
  }
  case "type": {
    const { session, rest: args } = extractSessionFlag(rest);
    const sel = args[0];
    const text = args.slice(1).join(" ");
    if (!sel || args.length < 2) {
      fail(`usage: drive.mjs type "<css selector>" <text> [--session id]`);
    }
    const typed = await withSession(async (s) => {
      const el = await findElement(s, sel);
      if (el.isErr()) return Result.err(el.error);
      const sent = await request("type failed", "POST", `/session/${s}/element/${el.value}/value`, {
        text,
      });
      return sent.map(() => undefined);
    }, session);
    if (typed.isErr()) failWith(typed.error);
    console.log(`typed into ${sel}`);
    break;
  }
  case "url": {
    const { session, rest: args } = extractSessionFlag(rest);
    const p = args[0] || "/";
    const full = `http://localhost:${devPort}${p.startsWith("/") ? p : `/${p}`}`;
    const navigated = await withSession(async (s) => {
      const sent = await request("navigate failed", "POST", `/session/${s}/url`, { url: full });
      return sent.map(() => undefined);
    }, session);
    if (navigated.isErr()) failWith(navigated.error);
    console.log(`navigated to ${full}`);
    break;
  }
  case "winshot": {
    const name = (rest[0] || "winshot").replace(/[^\w.-]/g, "_");
    const shot = await captureWindow(name);
    if (shot.isErr()) failWith(shot.error);
    const { file, rect } = shot.value;
    console.log(file);
    console.log(
      `  window fullscreen on ${rect.monitor} — ${rect.width}x${rect.height}+${rect.x}+${rect.y}`,
    );
    if (!rect.isTestMonitor) {
      console.log("  ⚠ single monitor — this covered the primary screen; restore with `unplace`");
    }
    break;
  }
  case "unplace": {
    const restored = await evalExpr(
      `window.__TAURI_INTERNALS__.invoke("wdio_place_on_test_monitor", { fullscreen: false })`,
    );
    if (restored.isErr()) failWith(restored.error);
    console.log("window restored from fullscreen");
    break;
  }
  case "console": {
    const read = await readConsole({ clear: rest.includes("--clear") });
    if (read.isErr()) failWith(read.error);
    const entries = read.value;
    if (entries === null) {
      fail(
        "no console collector in the page — is this a VITE_WDIO build (`bun run dev:drive`)?",
      );
    }
    if (entries.length === 0) {
      console.log("(no console errors or warnings)");
      break;
    }
    for (const e of entries) {
      console.log(`[${e.kind}] ${new Date(e.at).toISOString().slice(11, 19)} ${e.text}`);
    }
    // Non-zero on real errors so a caller can gate on this verb.
    process.exit(entries.some((e) => e.kind !== "warn") ? 1 : 0);
    break;
  }
  case undefined:
    usage(0);
    break;
  default:
    console.error(`[drive] unknown verb: ${verb}\n`);
    usage(1);
}

// `console` and `status` exit from inside their own case, so neither double-reports.
await surfaceConsoleErrors();
