import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Guards the published artifact against two failure classes that have shipped
 * broken releases before (v0.0.143):
 *
 * 1. `bun pm pack` silently excludes certain filenames (bunfig.toml among
 *    them), so a file can be tracked, committed, and still missing from the
 *    tarball. Test: every git-tracked file under the package.json `files`
 *    globs must appear in the tarball.
 *
 * 2. Runtime assets resolved relative to a module (`new URL(..., import.meta.url)`,
 *    `join(__dirname, ...)`) break when files move — the layout flatten pointed
 *    the sessionizer popup at a path that no longer existed. Test: every such
 *    literal in the packed sources must resolve to a real file in the tarball.
 */

const ROOT = resolve(import.meta.dirname, "..");
let workDir: string;
let extractDir: string;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "tt-pack-test-"));
  execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--quiet", "--destination", workDir], {
    cwd: ROOT,
    stdio: "pipe",
  });
  const tarball = readdirSync(workDir).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error(`bun pm pack produced no tarball in ${workDir}`);
  extractDir = join(workDir, "extract");
  execFileSync("tar", ["-xzf", join(workDir, tarball), "-C", workDir], { stdio: "pipe" });
  // tarball root is "package/"
  extractDir = join(workDir, "package");
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("packed tarball", () => {
  it("contains every git-tracked file under the published `files` globs", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      files: string[];
    };
    const tracked = execFileSync("git", ["ls-files", "--", ...pkg.files], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);

    const missing = tracked.filter((f) => !existsSync(join(extractDir, f)));
    expect(missing, `tracked files dropped by bun pm pack: ${missing.join(", ")}`).toEqual([]);
  });

  it("resolves every module-relative asset reference to a file in the tarball", () => {
    const sources = walk(extractDir).filter(
      (f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith(".test.ts"),
    );

    // new URL("<rel>", import.meta.url) and
    // join/resolve(__dirname | import.meta.dirname | import.meta.dir, "<seg>", ...)
    const urlPattern = /new URL\(\s*"([^"]+)"\s*,\s*import\.meta\.url\s*\)/g;
    const joinPattern =
      /(?:\w+\.)?(?:join|resolve)\(\s*(?:__dirname|import\.meta\.dirname|import\.meta\.dir)\s*((?:,\s*"[^"]+"\s*)+)\)/g;

    const broken: string[] = [];
    for (const file of sources) {
      const content = readFileSync(file, "utf8");
      const base = dirname(file);
      const refs: string[] = [];

      for (const m of content.matchAll(urlPattern)) refs.push(resolve(base, m[1]!));
      for (const m of content.matchAll(joinPattern)) {
        const segments = [...m[1]!.matchAll(/"([^"]+)"/g)].map((s) => s[1]!);
        refs.push(resolve(base, ...segments));
      }

      for (const ref of refs) {
        if (!existsSync(ref)) {
          broken.push(
            `${file.slice(extractDir.length + 1)} -> ${ref.slice(extractDir.length + 1)}`,
          );
        }
      }
    }
    expect(
      broken,
      `asset references that don't exist in the tarball:\n${broken.join("\n")}`,
    ).toEqual([]);
  });
});
