/** Browser stand-in for `node:fs/promises`, scoped to `@vscode/diff` by the
 * `vscodeDiffNodeShim` plugin in `vite.config.ts`. Throws by name where Vite's own
 * externalized stub would fail opaquely. */

export function readFile(): never {
  throw new Error("node:fs/promises.readFile is not available in the webview");
}
