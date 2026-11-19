// Model-checks every TLA+ spec under a `tla/` directory with everystate. A
// `<Module>.cfg` must pass; any other `<Module><Variant>.cfg` must open with
// `\* Expected to FAIL (<Invariant>)` and fail on exactly that invariant, so a
// model whose checks can no longer fail is caught too. `bun run check:tla`.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Result } from "better-result";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "node_modules", ".bin", "everystate");

const specs = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*/tla/*.tla"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

let failures = 0;
for (const spec of specs) {
  const dir = join(root, dirname(spec));
  const module = basename(spec, ".tla");
  const configs = readdirSync(dir).filter((f) => f.startsWith(module) && f.endsWith(".cfg"));
  if (!configs.includes(`${module}.cfg`)) {
    console.error(`✗ ${spec}: no ${module}.cfg`);
    failures++;
  }
  for (const config of configs) {
    const expected = readFileSync(join(dir, config), "utf8").match(/^\\\* Expected to FAIL \((\w+)\)/)?.[1];
    if (config !== `${module}.cfg` && !expected) {
      console.error(`✗ ${config}: a variant config must say which invariant it is expected to fail`);
      failures++;
      continue;
    }
    const run = spawnSync(bin, ["-json", "-workers", "auto", "-config", config, `${module}.tla`], {
      cwd: dir,
      encoding: "utf8",
    });
    const last = run.stdout.trim().split("\n").at(-1) ?? "";
    /** @type {{ status?: string, name?: string, distinct?: number }} */
    const result = Result.try(() => JSON.parse(last)).unwrapOr({
      status: `unparsed (exit ${run.status}): ${run.stderr || last}`,
    });
    const got = result.status === "ok" ? "ok" : `${result.status} ${result.name ?? ""}`.trim();
    const want = expected ? `invariant ${expected}` : "ok";
    const pass = got === want;
    console.log(`${pass ? "✓" : "✗"} ${dirname(spec)}/${config}: ${got} (${result.distinct ?? "?"} states)`);
    if (!pass) {
      console.error(`  expected ${want}`);
      failures++;
    }
  }
}

if (specs.length === 0) {
  console.error("no */tla/*.tla specs found");
  process.exit(1);
}
process.exit(failures ? 1 : 0);
