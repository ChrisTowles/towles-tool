import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import { resolveDevPort } from "../../scripts/task-port.mjs";
import pkg from "./package.json" with { type: "json" };

// @vscode/diff imports `node:fs/promises` from a Node-only branch a WebView
// never takes, and every chunk pulling it in warns. Scoped to that one dep
// rather than aliased globally, so the next Node builtin still says so.
function vscodeDiffNodeShim(): Plugin {
  const shim = path.resolve(__dirname, "./src/shims/node-fs-promises.ts");
  return {
    name: "tt:vscode-diff-node-shim",
    enforce: "pre",
    resolveId(source, importer) {
      if (source !== "node:fs/promises" || !importer?.includes("@vscode/diff")) return null;
      return shim;
    },
  };
}

// Dev-only: stamps the owning component's name into the DOM for the element
// inspector — as the *first class* (the hover tooltip shows only `classList`)
// plus `data-component` on the component root, for structural queries.
// Lowercase host tags only; a capitalized <Component/> would take them as props.
function componentNamePlugin({ types: t }: { types: typeof import("@babel/types") }) {
  const directName = (fnPath: any): string | null => {
    const node = fnPath.node;
    if (node.id?.name) return node.id.name;
    const parent = fnPath.parentPath;
    if (parent?.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
      return parent.node.id.name;
    }
    return null;
  };
  const enclosingComponentName = (el: any): string | null => {
    for (let fn = el.getFunctionParent(); fn; fn = fn.getFunctionParent()) {
      const name = directName(fn);
      if (name && /^[A-Z]/.test(name)) return name;
    }
    return null;
  };
  return {
    name: "tt:component-names",
    visitor: {
      JSXElement(el: any) {
        const opening = el.node.openingElement;
        if (!t.isJSXIdentifier(opening.name) || !/^[a-z]/.test(opening.name.name)) return;
        const name = enclosingComponentName(el);
        if (!name) return;

        // Prepend the name to className so the inspector tooltip shows it.
        const classAttr = opening.attributes.find(
          (a: any) => t.isJSXAttribute(a) && a.name.name === "className",
        );
        if (!classAttr) {
          opening.attributes.push(
            t.jsxAttribute(t.jsxIdentifier("className"), t.stringLiteral(name)),
          );
        } else if (t.isStringLiteral(classAttr.value)) {
          if (!classAttr.value.value.startsWith(`${name} `) && classAttr.value.value !== name) {
            classAttr.value = t.stringLiteral(`${name} ${classAttr.value.value}`);
          }
        } else if (
          t.isJSXExpressionContainer(classAttr.value) &&
          !t.isJSXEmptyExpression(classAttr.value.expression)
        ) {
          classAttr.value = t.jsxExpressionContainer(
            t.binaryExpression(
              "+",
              t.stringLiteral(`${name} `),
              t.logicalExpression("||", classAttr.value.expression, t.stringLiteral("")),
            ),
          );
        }

        // data-component marks the component's root element only.
        const parent = el.parentPath;
        const isRoot =
          parent.isReturnStatement() ||
          (parent.isArrowFunctionExpression() && parent.node.body === el.node);
        if (
          isRoot &&
          !opening.attributes.some(
            (a: any) => t.isJSXAttribute(a) && a.name.name === "data-component",
          )
        ) {
          opening.attributes.push(
            t.jsxAttribute(t.jsxIdentifier("data-component"), t.stringLiteral(name)),
          );
        }
      },
    },
  };
}

// Every @codingame/monaco-vscode-* package must be pre-bundled together (and
// deduped) so they share one module instance — otherwise the default-extension
// packages register grammars/themes into a different api copy and nothing
// highlights.
const monacoVscodeDeps = Object.keys(pkg.dependencies).filter((d) =>
  d.startsWith("@codingame/monaco-vscode-"),
);

// `dev-port.mjs` normally pins TT_DEV_PORT; run bare, resolve the same
// per-checkout claim from the repo root's rendered `.env`. No fallback: any
// port picked outside the claim system comes from the same 1420-1619 pool a
// sibling checkout may already hold. Resolved only when the server will bind
// it — `vite build` never listens, and CI has no rendered `.env`.
const repoRoot = path.resolve(__dirname, "../..");

function requireDevPort(): number {
  const port = Number(process.env.TT_DEV_PORT) || resolveDevPort(repoRoot).unwrapOr(undefined);
  if (!port) {
    throw new Error(
      "no TT_DEV_PORT for this checkout — run `tt task env <name>` to claim ports, " +
        "or pin TT_DEV_PORT in .env.local",
    );
  }
  return port;
}

export default defineConfig(({ command }) => ({
  plugins: [
    react(command === "serve" ? { babel: { plugins: [componentNamePlugin] } } : undefined),
    tailwindcss(),
    vscodeDiffNodeShim(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["monaco-editor", "vscode", ...monacoVscodeDeps],
  },
  // monaco-vscode-api relies on `new URL(..., import.meta.url)` inside deps
  // (broken by Vite's dep pre-bundling without this plugin) and ships some
  // CommonJS-only transitive deps that must be pre-bundled to load in workers.
  optimizeDeps: {
    include: [
      ...monacoVscodeDeps,
      "@codingame/monaco-vscode-api/extensions",
      "@codingame/monaco-vscode-api/monaco",
      "monaco-editor",
      "monaco-languageclient",
      "vscode-languageclient/browser",
      "vscode-jsonrpc",
    ],
    // importMetaUrlPlugin can't resolve @vscode/diff's `worker.js?esm` URL —
    // serve it unbundled instead of pre-optimizing it.
    exclude: ["@vscode/diff"],
    esbuildOptions: {
      plugins: [importMetaUrlPlugin],
    },
  },
  // The textmate tokenization worker code-splits, which rollup only supports
  // with ES-module workers. Worker builds are their own rollup pass and do NOT
  // inherit `plugins`, so the @vscode/diff shim is registered a second time.
  worker: {
    format: "es",
    plugins: () => [vscodeDiffNodeShim()],
  },
  // The ~2.4 MB main chunk is accepted: the monaco-vscode stack must stay one
  // module graph, and a Tauri webview loads from disk, so the 500 kB default (a
  // network heuristic) doesn't apply. Raised, not removed — ~3 MB should warn.
  build: {
    chunkSizeWarningLimit: 3000,
  },
  // Prevent Vite from obscuring Rust errors
  clearScreen: false,
  server:
    command === "serve"
      ? {
          port: requireDevPort(),
          strictPort: true,
        }
      : undefined,
  // Env variables starting with these prefixes are exposed to the client
  envPrefix: ["VITE_", "TAURI_"],
}));
