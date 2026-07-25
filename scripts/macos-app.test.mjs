// The bundle skeleton and its runner are plain filesystem/shell work, so they
// are testable off macOS — which is where they have to be tested, since CI and
// most development here run on Linux.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { cargoTripleKey, writeDevApp } from "./macos-app.mjs";

/** @returns {string} */
function scratch() {
  return mkdtempSync(path.join(tmpdir(), "macos-app-"));
}

/**
 * @param {string} dir
 * @returns {string} path to a stand-in for the binary cargo just built
 */
function fakeBinary(dir) {
  const bin = path.join(dir, "tt-app");
  writeFileSync(bin, '#!/bin/sh\necho "ran $0 with $*"\n');
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * @param {string} dir
 * @returns {string} the icns stand-in the skeleton copies into Resources
 */
function fakeIcns(dir) {
  const icns = path.join(dir, "icon.icns");
  writeFileSync(icns, "icns");
  return icns;
}

const spec = {
  productName: "Towles Tool",
  identifier: "dev.towles.tool",
  version: "0.1.2",
};

test("the skeleton carries the name, id and version macOS reads", () => {
  const dir = scratch();
  writeDevApp({ ...spec, dir, icns: fakeIcns(dir) });

  const app = path.join(dir, "Towles Tool.app");
  const plist = readFileSync(path.join(app, "Contents", "Info.plist"), "utf8");
  assert.match(plist, /<key>CFBundleName<\/key><string>Towles Tool<\/string>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>Towles Tool<\/string>/);
  assert.match(plist, /<key>CFBundleIdentifier<\/key><string>dev\.towles\.tool<\/string>/);
  assert.match(plist, /<key>CFBundleShortVersionString<\/key><string>0\.1\.2<\/string>/);
  assert.match(plist, /<key>CFBundleIconFile<\/key><string>icon\.icns<\/string>/);
  assert.equal(readFileSync(path.join(app, "Contents", "Resources", "icon.icns"), "utf8"), "icns");
});

test("the runner execs the built binary from inside the bundle", () => {
  const dir = scratch();
  const runner = writeDevApp({ ...spec, dir, icns: fakeIcns(dir) });

  const out = execFileSync(runner, [fakeBinary(dir), "--flag", "value"], { encoding: "utf8" });
  // What the launched process sees as its own path is the whole point: that is
  // what makes macOS find the Info.plist a directory above it.
  assert.match(out, /Towles Tool\.app\/Contents\/MacOS\/Towles Tool with --flag value/);
});

test("relinking after a rebuild picks up the new binary", () => {
  const dir = scratch();
  const runner = writeDevApp({ ...spec, dir, icns: fakeIcns(dir) });
  const bin = fakeBinary(dir);
  execFileSync(runner, [bin], { encoding: "utf8" });

  writeFileSync(bin, '#!/bin/sh\necho "rebuilt"\n');
  chmodSync(bin, 0o755);
  const out = execFileSync(runner, [bin], { encoding: "utf8" });
  assert.match(out, /rebuilt/);

  // A hardlink, not a copy — a debug build is hundreds of megabytes and this
  // runs on every `tauri dev` rebuild.
  const exe = path.join(dir, "Towles Tool.app", "Contents", "MacOS", "Towles Tool");
  assert.equal(statSync(exe).ino, statSync(bin).ino);
});

test("cargo's env spelling of a target triple", () => {
  assert.equal(cargoTripleKey("aarch64-apple-darwin"), "AARCH64_APPLE_DARWIN");
  assert.equal(cargoTripleKey("x86_64-apple-darwin"), "X86_64_APPLE_DARWIN");
});
