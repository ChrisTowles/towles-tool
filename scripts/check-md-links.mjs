// Fails when a tracked .md file links to a relative path or heading anchor that
// doesn't exist. Run from the repo root: `bun run check:md-links`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} text */
const stripFences = (text) => text.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, "");

/** @param {string} text */
const stripCode = (text) => stripFences(text).replace(/`[^`\n]*`/g, "");

/** @param {string} heading */
const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");

/** @type {Map<string, Set<string>>} */
const anchorCache = new Map();

/** @param {string} file */
function anchors(file) {
  let found = anchorCache.get(file);
  if (!found) {
    found = new Set();
    const seen = new Map();
    for (const [, heading] of stripFences(readFileSync(file, "utf8")).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
      const base = slug(heading.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      found.add(n ? `${base}-${n}` : base);
    }
    anchorCache.set(file, found);
  }
  return found;
}

const files = execFileSync("git", ["ls-files", "*.md"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && existsSync(resolve(root, f)));

const broken = [];
for (const rel of files) {
  const file = resolve(root, rel);
  const body = stripCode(readFileSync(file, "utf8"));
  const targets = [
    ...[...body.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]),
    ...[...body.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)].map((m) => m[1]),
    ...[...body.matchAll(/<(?:img|a)\s[^>]*?(?:src|href)="([^"]+)"/g)].map((m) => m[1]),
  ];
  for (const target of targets) {
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
    const [pathPart, fragment] = target.split("#");
    const dest = pathPart ? resolve(pathPart.startsWith("/") ? root : dirname(file), pathPart.replace(/^\//, "")) : file;
    if (!existsSync(dest)) {
      broken.push(`${rel}: ${target} (no such file)`);
    } else if (fragment && dest.endsWith(".md") && statSync(dest).isFile()) {
      if (!anchors(dest).has(decodeURIComponent(fragment).toLowerCase())) {
        broken.push(`${rel}: ${target} (no such heading)`);
      }
    }
  }
}

if (broken.length) {
  console.error(`${broken.length} broken markdown link(s):\n${broken.join("\n")}`);
  process.exit(1);
}
console.log(`checked ${files.length} markdown files, all relative links resolve`);
