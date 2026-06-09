import solidPlugin from "@opentui/solid/bun-plugin";

await Bun.build({
  entrypoints: ["./index.tsx"],
  outdir: "./dist",
  target: "bun",
  minify: true,
  plugins: [solidPlugin],
});

console.log("Build complete!");
