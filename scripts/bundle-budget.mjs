// Ratchet on the client bundle's gzipped size: fails when a build outgrows
// `bundle-budget.json`, and asks for the budget to be lowered when a build
// comes in well under it. Run after `vite build`: `bun run check:bundle`.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const budgetFile = resolve(root, "scripts/bundle-budget.json");
const assets = resolve(root, "apps/client/dist/assets");

/** Headroom under budget before the ratchet asks for it to be lowered. */
export const SLACK = 0.02;

/** @typedef {{ js: number, css: number }} Sizes */

/**
 * @param {Sizes} measured
 * @param {Sizes} budget
 * @returns {{ over: string[], loosen: string[] }}
 */
export function compare(measured, budget) {
  const over = [];
  const loosen = [];
  for (const kind of /** @type {const} */ (["js", "css"])) {
    if (measured[kind] > budget[kind]) {
      over.push(`${kind}: ${kb(measured[kind])} gzipped, budget ${kb(budget[kind])}`);
    } else if (measured[kind] < budget[kind] * (1 - SLACK)) {
      loosen.push(`${kind}: ${kb(measured[kind])} gzipped, budget ${kb(budget[kind])}`);
    }
  }
  return { over, loosen };
}

/** @param {number} bytes */
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

/** @returns {Sizes} */
function measure() {
  /** @type {Sizes} */
  const sizes = { js: 0, css: 0 };
  for (const name of readdirSync(assets)) {
    const kind = extname(name).slice(1);
    if (kind === "js" || kind === "css") {
      sizes[kind] += gzipSync(readFileSync(resolve(assets, name))).length;
    }
  }
  return sizes;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const measured = measure();
  if (process.argv.includes("--write")) {
    // Rounded up to whole KiB so another zlib build's byte-level drift can't fail CI.
    const budget = { js: Math.ceil(measured.js / 1024) * 1024, css: Math.ceil(measured.css / 1024) * 1024 };
    writeFileSync(budgetFile, `${JSON.stringify(budget, null, 2)}\n`);
    console.log(`bundle budget set to js ${kb(budget.js)}, css ${kb(budget.css)}`);
    process.exit(0);
  }
  const { over, loosen } = compare(measured, JSON.parse(readFileSync(budgetFile, "utf8")));
  for (const line of over) console.error(`over budget — ${line}`);
  for (const line of loosen) console.error(`under budget — ${line}; lock it in with \`bun run check:bundle --write\``);
  if (over.length) {
    console.error("Shrink the bundle, or raise scripts/bundle-budget.json in this PR and say why.");
  }
  process.exit(over.length || loosen.length ? 1 : 0);
}
