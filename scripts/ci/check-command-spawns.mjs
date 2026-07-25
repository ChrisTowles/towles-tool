#!/usr/bin/env node
// Invariant: every subprocess spawn must go through tt-exec (which opens a
// `process.spawn` telemetry span) or, for spawns that outlive the call,
// `tt_exec::record_detached_spawn`. A bare `Command::new` in production code is
// the one way to break the "what did this launch?" guarantee in the telemetry
// log (see the tt-telemetry section in CLAUDE.md).
//
// This check fails if `Command::new` / `process::Command` / `tokio::process::Command`
// appears in a .rs file outside the allowed set:
//   - crates/tt-exec/**            (the wrapper home itself)
//   - crates/tt-telemetry/build.rs (build-time git probe, pre-telemetry)
//   - any `tests/` integration-test directory
//   - any `#[cfg(test)]`-gated code (unit tests)
//   - a whole module declared `#[cfg(test)] mod foo;` — the gate is on the
//     declaration, so the module's own file has nothing in it to detect
//   - the three audited detached-spawn prod sites, which each call
//     `record_detached_spawn` before the raw spawn.
//
// Run from the repo root: `node scripts/ci/check-command-spawns.mjs`

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SPAWN_RE = /\b(?:tokio::process::Command|process::Command|Command)::new\b/;

// Exact prod files that legitimately hold a raw detached spawn paired with a
// `record_detached_spawn` call. Verified in the 2026-07 CI audit; keep in sync
// if a new detached-spawn site is added (it must call record_detached_spawn).
const ALLOWED_FILES = new Set([
  "crates-tauri/tt-app/src/terminal.rs",
  "crates-tauri/tt-app/src/agentboard.rs",
  "crates-tauri/tt-app/src/lsp.rs",
  "crates/tt-telemetry/build.rs",
]);

/** @param {string} path */
function isAllowedPath(path) {
  if (ALLOWED_FILES.has(path)) return true;
  if (path.startsWith("crates/tt-exec/")) return true;
  // Integration-test crates live under a `tests/` directory segment.
  if (/(^|\/)tests\//.test(path)) return true;
  return false;
}

// Remove string/char literals and line comments so their braces and the token
// don't confuse brace-depth tracking or trigger false matches.
/** @param {string} line */
function scrub(line) {
  return line
    .replace(/\/\/.*$/, "")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

// Returns the set of 1-based line numbers that sit inside a `#[cfg(test)]`-gated
// item (mod/fn/impl). Naive brace tracking on scrubbed lines is enough for this
// repo's test modules.
/** @param {string[]} lines */
function testGatedLines(lines) {
  const gated = new Set();
  let depth = 0;
  let awaitingBlock = false; // saw #[cfg(test)], waiting for its opening brace
  let inTestAtDepth = null; // depth the test block will close back to
  for (let i = 0; i < lines.length; i++) {
    const scrubbed = scrub(lines[i]);
    if (inTestAtDepth !== null) gated.add(i + 1);
    else if (awaitingBlock) gated.add(i + 1);

    const opens = (scrubbed.match(/\{/g) || []).length;
    const closes = (scrubbed.match(/\}/g) || []).length;

    if (awaitingBlock && opens > 0) {
      inTestAtDepth = depth; // block will close when depth returns here
      awaitingBlock = false;
    }
    depth += opens - closes;
    if (inTestAtDepth !== null && depth <= inTestAtDepth) inTestAtDepth = null;

    if (/#\[cfg\(test\)\]/.test(scrubbed)) awaitingBlock = true;
  }
  return gated;
}

// Files that exist only for tests because their *declaration* is gated:
// `#[cfg(test)] mod testrepo;` compiles `testrepo.rs` into test builds alone.
// The gate lives in the declaring file, so scanning the module's own file for
// `#[cfg(test)]` finds nothing — it has to be resolved from the declaration.
/** @param {string[]} paths */
function testOnlyModuleFiles(paths) {
  const gatedModules = new Set();
  const declRe = /#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
  for (const path of paths) {
    const text = readFileSync(path, "utf8");
    const dir = path.slice(0, path.lastIndexOf("/"));
    for (const m of text.matchAll(declRe)) {
      // A `mod foo;` resolves to `foo.rs` or `foo/mod.rs` beside the declarer.
      gatedModules.add(`${dir}/${m[1]}.rs`);
      gatedModules.add(`${dir}/${m[1]}/mod.rs`);
    }
  }
  return gatedModules;
}

function rsFiles() {
  const out = execFileSync(
    "git",
    ["ls-files", "crates/*.rs", "crates-cli/*.rs", "crates-tauri/*.rs"],
    { encoding: "utf8" },
  );
  return out.split("\n").filter(Boolean);
}

const violations = [];
const paths = rsFiles();
const testOnlyFiles = testOnlyModuleFiles(paths);
for (const path of paths) {
  if (isAllowedPath(path) || testOnlyFiles.has(path)) continue;
  const lines = readFileSync(path, "utf8").split("\n");
  const gated = testGatedLines(lines);
  for (let i = 0; i < lines.length; i++) {
    const scrubbed = scrub(lines[i]);
    if (SPAWN_RE.test(scrubbed) && !gated.has(i + 1)) {
      violations.push(`${path}:${i + 1}: ${lines[i].trim()}`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    "Bare subprocess spawn(s) found outside tt-exec / detached-spawn sites.\n" +
      "Route spawns through tt-exec's run paths (they open a process.spawn span),\n" +
      "or call tt_exec::record_detached_spawn for spawns that outlive the call.\n" +
      "See the tt-telemetry section in CLAUDE.md.\n",
  );
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}

console.log("OK: no bare subprocess spawns outside tt-exec / allowed sites.");
