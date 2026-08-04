/** Lazy Monaco loader over @codingame/monaco-vscode-api, with real VS Code services
 * underneath, bundled locally by Vite — no CDN, works offline in the Tauri shell.
 * The editor renders Default Dark Modern whatever the app's mode. */

import { FILE_NESTING_PATTERNS } from "@/lib/file-nesting";
import { PRUNED_COMMANDS, staleCommands } from "@/lib/monaco-prune";

let loading: Promise<typeof import("monaco-editor")> | null = null;

/** The editor API only if another consumer booted it; never triggers a load. */
export function loadedMonaco(): Promise<typeof import("monaco-editor")> | null {
  return loading;
}

export function loadMonaco(): Promise<typeof import("monaco-editor")> {
  // The catch clears the cache: without it one failed bootstrap poisons
  // every editor, diff and quick-open for the life of the window.
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
    ,
    configuration,
    languages,
    textmate,
    theme,
    model,
    quickaccess,
    views,
    explorer,
    search,
    tauriFs,
    dialogs,
    editorWorker,
    textmateWorker,
  ] = await Promise.all([
    import("monaco-editor"),
    import("@codingame/monaco-vscode-api"),
    // Must precede initialize: the LSP bridge runs as a local extension.
    import("vscode/localExtensionHost"),
    import("@codingame/monaco-vscode-configuration-service-override"),
    import("@codingame/monaco-vscode-languages-service-override"),
    import("@codingame/monaco-vscode-textmate-service-override"),
    import("@codingame/monaco-vscode-theme-service-override"),
    import("@codingame/monaco-vscode-model-service-override"),
    import("@codingame/monaco-vscode-quickaccess-service-override"),
    import("@codingame/monaco-vscode-views-service-override"),
    import("@codingame/monaco-vscode-explorer-service-override"),
    import("@codingame/monaco-vscode-search-service-override"),
    import("@/lib/monaco-fs"),
    import("@/lib/monaco-dialogs"),
    import("monaco-editor/esm/vs/editor/editor.worker?worker"),
    import("@codingame/monaco-vscode-textmate-service-override/worker?worker"),
    // Side-effect imports: each registers grammars/themes as a built-in extension.
  ]);
  const [themeDefaults, setiIcons] = await Promise.all([
    import("@codingame/monaco-vscode-theme-defaults-default-extension"),
    import("@codingame/monaco-vscode-theme-seti-default-extension"),
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
      "workbench.iconTheme": "vs-seti",
      "editor.stickyScroll.enabled": true,
      // The only completion source for the ~34 languages with no LSP.
      "editor.wordBasedSuggestions": "allDocuments",
      "editor.bracketPairColorization.enabled": true,
      "editor.guides.bracketPairs": "active",
      "search.exclude": {
        "**/node_modules": true,
        "**/target": true,
        "**/dist": true,
        "**/.git": true,
      },
      // The diff pane's rail runs the same table through its own matcher; only
      // the Explorer can be driven by configuration.
      "explorer.fileNesting.enabled": true,
      "explorer.fileNesting.expand": false,
      "explorer.fileNesting.patterns": FILE_NESTING_PATTERNS,
      "files.exclude": {
        "**/.git": true,
      },
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
    // After quickaccess, so the workbench's own quick-input wiring wins where
    // they overlap. No editor part is attached; the fallback routes to our viewer.
    ...views.default(async (modelRef) => {
      const uri = modelRef.object.textEditorModel.uri;
      modelRef.dispose();
      if (uri.scheme === "file" && openHandler != null) openHandler(uri.path);
      return undefined;
    }),
    ...explorer.default(),
    ...search.default(),
    // Last: nothing above may reinstate the standalone blocking-confirm service.
    ...dialogs.default(),
  });
  tauriFs.registerTauriFileSystem();
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
  // The configured theme/icon ids above race these async registrations — await
  // them, or the editor falls back to the default theme and the Explorer to none.
  await Promise.all([themeDefaults.whenReady(), setiIcons.whenReady()]);
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource) {
      if (resource.scheme !== "file" || openHandler == null) return false;
      openHandler(resource.path);
      return true;
    },
  });
  // Right-click in the Explorer tree → the user's own editor. The tree hands
  // the clicked resource to the command as its first argument.
  monaco.editor.registerCommand(
    "tt.openExplorerItemExternally",
    (_accessor, resource?: { scheme?: string; path?: string }) => {
      if (resource?.scheme !== "file" || !resource.path) return;
      const path = resource.path;
      void import("@/lib/external-editor").then(({ openInExternalEditor }) =>
        openInExternalEditor(path, { where: "files.explorer" }),
      );
    },
  );
  const actions =
    await import("@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions");
  actions.MenuRegistry.appendMenuItem(actions.MenuId.ExplorerContext, {
    command: { id: "tt.openExplorerItemExternally", title: "Open in External Editor" },
    group: "navigation",
    order: 20,
  });
  return monaco;
}

let workspaceDir: string | null = null;
let unwatchWorkspace: (() => void) | null = null;

/** Point the VS Code workspace at one folder — one at a time, last pane wins.
 * The disk watch feeding the Explorer follows the workspace, same lifecycle. */
export async function setMonacoWorkspace(dir: string): Promise<void> {
  const monaco = await loadMonaco();
  if (workspaceDir === dir) return;
  workspaceDir = dir;
  const { reinitializeWorkspace } =
    await import("@codingame/monaco-vscode-configuration-service-override");
  await reinitializeWorkspace({ id: dir, uri: monaco.Uri.file(dir) });
  const [{ syncLspWorkspace }, { watchWorkspaceForExplorer }] = await Promise.all([
    import("@/lib/lsp"),
    import("@/lib/monaco-fs"),
  ]);
  syncLspWorkspace(dir);
  unwatchWorkspace?.();
  unwatchWorkspace = watchWorkspaceForExplorer(dir);
}

let detachSidebar: (() => void) | null = null;

/** Host the workbench sidebar part inside `container`. It is a singleton — a newer
 * attach steals it, and the returned detach no-ops once someone else has. */
export async function attachExplorer(container: HTMLElement): Promise<() => void> {
  await loadMonaco();
  const [views, layout] = await Promise.all([
    import("@codingame/monaco-vscode-views-service-override"),
    import("@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService"),
  ]);
  detachSidebar?.();
  const attached = views.attachPart(layout.Parts.SIDEBAR_PART, container);
  const mine = () => {
    attached.dispose();
    if (detachSidebar === mine) detachSidebar = null;
  };
  detachSidebar = mine;
  return mine;
}

/** The file tree and the search form are two view containers in the same part, so
 * `attachExplorer` hosts whichever the workbench has made active. */
export type SidebarView = "explorer" | "search";

const SIDEBAR_VIEW_IDS: Record<SidebarView, string> = {
  explorer: "workbench.view.explorer",
  search: "workbench.view.search",
};

function sidebarViewForId(id: string | undefined): SidebarView | null {
  const found = (Object.keys(SIDEBAR_VIEW_IDS) as SidebarView[]).find(
    (view) => SIDEBAR_VIEW_IDS[view] === id,
  );
  return found ?? null;
}

async function paneComposites() {
  await loadMonaco();
  const [api, views] = await Promise.all([
    import("@codingame/monaco-vscode-api"),
    import("@codingame/monaco-vscode-views-service-override"),
  ]);
  const service = await api.getService(api.IPaneCompositePartService);
  return { service, sidebar: views.ViewContainerLocation.Sidebar };
}

export async function openSidebarView(view: SidebarView): Promise<void> {
  try {
    const { service, sidebar } = await paneComposites();
    await service.openPaneComposite(SIDEBAR_VIEW_IDS[view], sidebar, true);
  } catch (e) {
    console.error(`[monaco] failed to open the ${view} view`, e);
  }
}

/** The workbench switches views on its own ("Find in Folder" opens search), so a
 * mode control must follow the part rather than assume it drives it. */
export function watchSidebarView(listener: (view: SidebarView | null) => void): () => void {
  let disposed = false;
  let dispose: (() => void) | null = null;
  void (async () => {
    try {
      const { service, sidebar } = await paneComposites();
      if (disposed) return;
      listener(sidebarViewForId(service.getActivePaneComposite(sidebar)?.getId()));
      const sub = service.onDidPaneCompositeOpen(({ composite, viewContainerLocation }) => {
        if (viewContainerLocation === sidebar) listener(sidebarViewForId(composite.getId()));
      });
      if (disposed) sub.dispose();
      else dispose = () => sub.dispose();
    } catch (e) {
      console.error("[monaco] failed to watch the sidebar view", e);
    }
  })();
  return () => {
    disposed = true;
    dispose?.();
  };
}

export async function runMonacoCommand(id: string): Promise<void> {
  try {
    await loadMonaco();
    const api = await import("@codingame/monaco-vscode-api");
    const commands = await api.getService(api.ICommandService);
    await commands.executeCommand(id);
  } catch (e) {
    console.error(`[monaco] command ${id} failed`, e);
  }
}

type OpenFileHandler = (absolutePath: string) => void;
let openHandler: OpenFileHandler | null = null;

export function setMonacoOpenHandler(handler: OpenFileHandler | null): void {
  openHandler = handler;
}
