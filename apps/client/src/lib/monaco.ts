/** Lazy Monaco loader over @codingame/monaco-vscode-api, with real VS Code services
 * underneath, bundled locally by Vite — no CDN, works offline in the Tauri shell. Serves the
 * diff pane's editors and the Markdown colorizer; the Files pane is code-server. The editor
 * renders Default Dark Modern whatever the app's mode. */

import { PRUNED_COMMANDS, staleCommands } from "@/lib/monaco-prune";

let loading: Promise<typeof import("monaco-editor")> | null = null;

/** The editor API only if another consumer booted it; never triggers a load. */
export function loadedMonaco(): Promise<typeof import("monaco-editor")> | null {
  return loading;
}

export function loadMonaco(): Promise<typeof import("monaco-editor")> {
  // The catch clears the cache: without it one failed bootstrap poisons
  // every editor and diff for the life of the window.
  loading ??= start().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

async function start(): Promise<typeof import("monaco-editor")> {
  const [
    monaco,
    api,
    configuration,
    languages,
    textmate,
    theme,
    model,
    quickaccess,
    dialogs,
    editorWorker,
    textmateWorker,
  ] = await Promise.all([
    import("monaco-editor"),
    import("@codingame/monaco-vscode-api"),
    import("@codingame/monaco-vscode-configuration-service-override"),
    import("@codingame/monaco-vscode-languages-service-override"),
    import("@codingame/monaco-vscode-textmate-service-override"),
    import("@codingame/monaco-vscode-theme-service-override"),
    import("@codingame/monaco-vscode-model-service-override"),
    import("@codingame/monaco-vscode-quickaccess-service-override"),
    import("@/lib/monaco-dialogs"),
    import("monaco-editor/esm/vs/editor/editor.worker?worker"),
    import("@codingame/monaco-vscode-textmate-service-override/worker?worker"),
  ]);
  // Side-effect imports: each registers grammars/themes as a built-in extension.
  const [themeDefaults] = await Promise.all([
    import("@codingame/monaco-vscode-theme-defaults-default-extension"),
    import("@codingame/monaco-vscode-rust-default-extension"),
    import("@codingame/monaco-vscode-typescript-basics-default-extension"),
    import("@codingame/monaco-vscode-javascript-default-extension"),
    import("@codingame/monaco-vscode-json-default-extension"),
    import("@codingame/monaco-vscode-css-default-extension"),
    import("@codingame/monaco-vscode-html-default-extension"),
    import("@codingame/monaco-vscode-markdown-basics-default-extension"),
    import("@codingame/monaco-vscode-yaml-default-extension"),
    import("@codingame/monaco-vscode-shellscript-default-extension"),
    import("@codingame/monaco-vscode-python-default-extension"),
    import("@codingame/monaco-vscode-log-default-extension"),
    import("@codingame/monaco-vscode-diff-default-extension"),
    // The rest of VS Code's built-in grammars. `lib/language-fallback.ts` covers
    // what upstream ships none for (TOML) and the names its lists miss.
    import("@codingame/monaco-vscode-ini-default-extension"),
    import("@codingame/monaco-vscode-git-base-default-extension"),
    import("@codingame/monaco-vscode-docker-default-extension"),
    import("@codingame/monaco-vscode-make-default-extension"),
    import("@codingame/monaco-vscode-sql-default-extension"),
    import("@codingame/monaco-vscode-xml-default-extension"),
    import("@codingame/monaco-vscode-cpp-default-extension"),
    import("@codingame/monaco-vscode-go-default-extension"),
    import("@codingame/monaco-vscode-java-default-extension"),
    import("@codingame/monaco-vscode-csharp-default-extension"),
    import("@codingame/monaco-vscode-ruby-default-extension"),
    import("@codingame/monaco-vscode-php-default-extension"),
    import("@codingame/monaco-vscode-lua-default-extension"),
    import("@codingame/monaco-vscode-perl-default-extension"),
    import("@codingame/monaco-vscode-swift-default-extension"),
    import("@codingame/monaco-vscode-r-default-extension"),
    import("@codingame/monaco-vscode-powershell-default-extension"),
    import("@codingame/monaco-vscode-bat-default-extension"),
    import("@codingame/monaco-vscode-scss-default-extension"),
    import("@codingame/monaco-vscode-less-default-extension"),
    // No standalone language features: their TS worker has no tsconfig and no
    // module resolution, so every real source file lit up with bogus errors.
  ]);
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      return label === "TextMateWorker" ? new textmateWorker.default() : new editorWorker.default();
    },
  };
  // Through user config, seeded before the services start — `setTheme`
  // races the theme service's own async startup restore and loses.
  await configuration.initUserConfiguration(
    JSON.stringify({
      "workbench.colorTheme": "Default Dark Modern",
      "editor.stickyScroll.enabled": true,
      // The only completion source: no language server is wired in.
      "editor.wordBasedSuggestions": "allDocuments",
      "editor.bracketPairColorization.enabled": true,
      "editor.guides.bracketPairs": "active",
    }),
  );
  await api.initialize({
    ...configuration.default(),
    ...languages.default(),
    ...textmate.default(),
    ...theme.default(),
    ...model.default(),
    ...quickaccess.default({
      isKeybindingConfigurationVisible: () => false,
      shouldUseGlobalPicker: () => true,
    }),
    // Last: nothing above may reinstate the standalone blocking-confirm service.
    ...dialogs.default(),
  });
  // Checked before shadowing — afterwards every id exists by construction, so a
  // rename would look healthy while the real handler stayed live.
  const { CommandsRegistry } =
    await import("@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands");
  const stale = staleCommands(CommandsRegistry.getCommands().keys());
  if (stale.length > 0) {
    console.error(
      `[monaco] shadowed commands are gone upstream (renamed?), so they are live again: ${stale.join(", ")}`,
    );
  }
  // After initialize: CommandsRegistry keeps the newest handler for an id.
  for (const id of PRUNED_COMMANDS) monaco.editor.registerCommand(id, () => {});
  // The configured theme id above races this async registration — await it, or
  // the editor falls back to the default theme.
  await themeDefaults.whenReady();
  return monaco;
}
