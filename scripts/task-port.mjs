// Per-task Vite dev-server port, from the `${tt:port}` claim in `.env`. No
// derived/hashed fallback: an unclaimed port can collide with a sibling
// checkout's, and `killPort` would then kill that sibling's dev server.
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { Result } from "better-result";
import { DevPortInvalid, DevPortUnset, EnvFileUnreadable, TaskEnvRenderFailed } from "./errors.mjs";
import { macosDevAppEnv } from "./macos-app.mjs";

const scriptsRepoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** @param {string} path */
function readEnvFile(path) {
  try {
    return Result.ok(readFileSync(path, "utf8"));
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e)?.code === "ENOENT") return Result.ok(null);
    return Result.err(new EnvFileUnreadable({ path, cause: e }));
  }
}

/** @param {string} repoRoot */
export function loadEnvFiles(repoRoot) {
  for (const file of [".env.local", ".env"]) {
    const read = readEnvFile(join(repoRoot, file));
    if (read.isErr()) return Result.err(read.error);
    const raw = read.value;
    if (raw === null) continue;
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      const key = match[1];
      let value = match[2];
      if (key === undefined || value === undefined) continue;
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
  return Result.ok(undefined);
}

/** @param {string} repoRoot */
export function resolveDevPort(repoRoot) {
  const loaded = loadEnvFiles(repoRoot);
  if (loaded.isErr()) return Result.err(loaded.error);
  const override = process.env.TT_DEV_PORT;
  if (override === undefined || override === "") return Result.err(new DevPortUnset());
  const port = Number(override);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return Result.err(new DevPortInvalid({ value: override }));
  }
  return Result.ok(port);
}

/** @param {string} repoRoot */
export function taskEnvName(repoRoot) {
  const worktrees = dirname(repoRoot);
  const claude = dirname(worktrees);
  return basename(worktrees) === "worktrees" && basename(claude) === ".claude"
    ? basename(repoRoot)
    : "primary";
}

/**
 * @param {string} repoRoot
 * @param {string} name
 */
function renderTaskEnv(repoRoot, name) {
  return Result.try({
    try: () => {
      execFileSync("tt", ["task", "env", name], { cwd: repoRoot, stdio: "inherit" });
    },
    catch: (e) => new TaskEnvRenderFailed({ name, cause: e }),
  });
}

/**
 * @param {string} repoRoot
 * @param {{ tag?: string; render?: boolean }} [opts] `render` claims ports first
 */
export function requireDevPort(repoRoot, { tag = "task-port", render = false } = {}) {
  const name = taskEnvName(repoRoot);

  /** @param {ReturnType<typeof resolveDevPort>} resolved */
  const die = (resolved) => {
    if (resolved.isErr() && !DevPortUnset.is(resolved.error)) {
      console.error(`[${tag}] ${resolved.error.message}`);
      process.exit(1);
    }
    console.error(
      `[${tag}] no TT_DEV_PORT for this checkout — run \`tt task env ${name}\` to claim ports, ` +
        `or pin TT_DEV_PORT in .env.local`,
    );
    process.exit(1);
  };

  let resolved = resolveDevPort(repoRoot);
  if (resolved.isOk()) return resolved.value;
  if (!DevPortUnset.is(resolved.error)) return die(resolved);

  if (!render) return die(resolved);

  console.log(`[${tag}] no TT_DEV_PORT yet — rendering .env via \`tt task env ${name}\``);
  const rendered = renderTaskEnv(repoRoot, name);
  if (rendered.isErr()) console.error(`[${tag}] ${rendered.error.message}`);

  resolved = resolveDevPort(repoRoot);
  return resolved.isOk() ? resolved.value : die(resolved);
}

/** @param {number} devPort */
export function resolveWebdriverPort(devPort) {
  return Number(process.env.TT_E2E_WEBDRIVER_PORT) || devPort + 3000;
}

/** @param {number} port */
export function isPortFree(port) {
  const out = execFileSync("tt", ["task", "ports", "--probe", String(port), "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return Promise.resolve(!JSON.parse(out).occupied);
}

/** @param {number} port */
function listeningPids(port) {
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return [...new Set(out.split("\n").map((s) => s.trim()).filter(Boolean))];
  } catch {
    return []; // lsof exits 1 on no match; an lsof-less platform has none either
  }
}

// Rejects pgid < 2: `killPort` negates it, and -0/-1 are kill(2) wildcards.
/** @param {string} pid */
function pgidOf(pid) {
  try {
    const pgid = execFileSync("ps", ["-o", "pgid=", "-p", pid], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return Number(pgid) >= 2 ? pgid : null;
  } catch {
    return null; // process already gone
  }
}

/**
 * @param {number} port
 * @param {number} timeoutMs
 * @param {number} pollMs
 */
async function waitUntilFree(port, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listeningPids(port).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return listeningPids(port).length === 0;
}

// Kills the whole process group, not just lsof's pid. Only ever for a port this
// task owns — on a scanned one the listener may be a sibling's dev server.
/** @param {number} port */
export async function killPort(port) {
  if (process.platform === "win32") return;
  const pids = listeningPids(port);
  if (!pids.length) return;

  /** @type {Set<string>} */
  const pgids = new Set(pids.map(pgidOf).filter((pgid) => pgid !== null));
  if (!pgids.size) return;

  console.log(
    `[task-port] port ${port} is already in use — stopping it (pgid ${[...pgids].join(", ")})`,
  );
  for (const pgid of pgids) {
    try {
      process.kill(-Number(pgid), "SIGTERM");
    } catch { // already gone
    }
  }

  if (await waitUntilFree(port, 3000, 100)) return;

  console.log(`[task-port] port ${port} still in use after SIGTERM — sending SIGKILL`);
  for (const pgid of pgids) {
    try {
      process.kill(-Number(pgid), "SIGKILL");
    } catch { // already gone
    }
  }
  await waitUntilFree(port, 2000, 100);
}

/**
 * Own process-group leader: signalling the one visible pid leaves vite orphaned.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
export function spawnTauriDev(args, env) {
  const posix = process.platform !== "win32";
  const child = spawn("tauri", args, {
    stdio: "inherit",
    // macOS only: runs the dev binary from a generated `.app` for the Dock icon.
    env: { ...env, ...macosDevAppEnv(scriptsRepoRoot) },
    shell: !posix,
    detached: posix, // Windows `detached` means "own console", not a group
  });

  if (posix) {
    /** @param {NodeJS.Signals} signal */
    const forward = (signal) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch { // already gone
      }
    };
    /** @type {NodeJS.Signals[]} */
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of signals) {
      process.on(signal, () => forward(signal));
    }
  }

  child.on("exit", (code) => process.exit(code ?? 0));
  return child;
}
