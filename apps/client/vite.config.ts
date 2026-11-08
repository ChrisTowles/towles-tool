import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig, type Plugin } from "vite";
import { resolveDevPort } from "../../scripts/task-port.mjs";

// tt-app embeds `dist/` and cargo fingerprints it by mtime, so rewriting identical files
// recompiles tt-app on every `tauri build`. Write only changed files; prune stale ones.
function writeOnlyChanged(): Plugin {
  let outDir = "";
  let emitted = new Set<string>();
  return {
    name: "tt:write-only-changed",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    generateBundle: {
      order: "post",
      handler(_, bundle) {
        emitted = new Set(Object.keys(bundle));
        for (const [name, out] of Object.entries(bundle)) {
          const file = path.join(outDir, name);
          const bytes = Buffer.from(out.type === "chunk" ? out.code : out.source);
          if (existsSync(file) && readFileSync(file).equals(bytes)) delete bundle[name];
        }
      },
    },
    writeBundle() {
      for (const rel of readdirSync(outDir, { recursive: true, encoding: "utf8" })) {
        const file = path.join(outDir, rel);
        const name = rel.split(path.sep).join("/");
        if (!emitted.has(name) && statSync(file).isFile()) rmSync(file);
      }
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
    writeOnlyChanged(),
    // `ANALYZE=1 bun run build` writes a treemap + per-chunk sizes to dist-stats/.
    ...(process.env.ANALYZE
      ? [
          visualizer({
            filename: "dist-stats/stats.html",
            template: "treemap",
            gzipSize: true,
          }),
        ]
      : []),
  ],
  // writeOnlyChanged prunes instead; emptying first would rewrite every file.
  build: { emptyOutDir: false },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
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
