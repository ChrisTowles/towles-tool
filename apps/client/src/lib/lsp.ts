/** LSP bridge: rust-analyzer runs app-side (`crates-tauri/tt-app/src/lsp.rs`);
 * monaco-languageclient speaks to it over Tauri IPC — `lsp_send` down,
 * `lsp://msg` events up. One server, following the active workspace. */

import { AbstractMessageReader, AbstractMessageWriter } from "vscode-jsonrpc";
import type { DataCallback, Disposable, Message } from "vscode-jsonrpc";
import { invoke, isTauri } from "@/lib/tauri";
import { errorMessage } from "@/lib/errors";
import { loadMonaco } from "@/lib/monaco";
import { setLspStatus } from "@/lib/lsp-status";

class TauriMessageReader extends AbstractMessageReader {
  private unlisten: (() => void) | null = null;
  private callback: DataCallback | null = null;
  private buffered: Message[] = [];
  constructor(private readonly serverId: number) {
    super();
  }
  /** Await this BEFORE starting the language client, or the server's
   * `initialize` response can race listener registration and get dropped. */
  async attach(): Promise<void> {
    const { listen } = await import("@tauri-apps/api/event");
    const msg = await listen<{ id: number; message: string }>("lsp://msg", (e) => {
      if (e.payload.id !== this.serverId) return;
      const parsed = JSON.parse(e.payload.message) as Message;
      if (this.callback) this.callback(parsed);
      else this.buffered.push(parsed);
    });
    const exit = await listen<{ id: number }>("lsp://exit", (e) => {
      if (e.payload.id === this.serverId) this.fireClose();
    });
    this.unlisten = () => {
      msg();
      exit();
    };
  }
  listen(callback: DataCallback): Disposable {
    this.callback = callback;
    for (const m of this.buffered.splice(0)) callback(m);
    return { dispose: () => this.dispose() };
  }
  override dispose(): void {
    super.dispose();
    this.callback = null;
    this.unlisten?.();
    this.unlisten = null;
  }
}

class TauriMessageWriter extends AbstractMessageWriter {
  constructor(private readonly serverId: number) {
    super();
  }
  /** vscode-jsonrpc's contract: a failed write must reject, or the language
   * client waits on a response that will never arrive. */
  async write(msg: Message): Promise<void> {
    const sent = await invoke("lsp_send", { id: this.serverId, message: JSON.stringify(msg) });
    if (sent.isErr()) throw new Error(errorMessage(sent.error));
  }
  end(): void {}
}

let current: { dir: string; stop: () => void } | null = null;
// A fresh page means every server the previous page started is an orphan —
// reap them before the first start. (Module scope = runs once per page.)
let switching: Promise<void> = invoke("lsp_stop_all").then(() => {});

/** Serialized, so rapid workspace switches can't interleave. A folder without
 * Cargo.toml just stops the previous server. */
export function syncLspWorkspace(dir: string): void {
  if (!isTauri()) return;
  switching = switching
    .then(async () => {
      if (current?.dir === dir) return;
      current?.stop();
      current = null;
      const isRust = await invoke("ide_stat", { dir, filePath: "Cargo.toml" });
      if (isRust.isErr()) {
        setLspStatus({ state: "off", dir });
        return;
      }
      setLspStatus({ state: "starting", dir });
      try {
        current = { dir, stop: await startRustAnalyzer(dir) };
        setLspStatus({ state: "ready", dir });
      } catch (e) {
        const detail = errorMessage(e);
        const stack = e instanceof Error ? (e.stack ?? "") : "";
        setLspStatus({ state: "failed", dir, detail });
        console.warn(`rust-analyzer bridge failed to start: ${detail}\n${stack}`);
      }
      // The chain is the serialization mechanism, so it must never settle
      // rejected — every later workspace switch would be silently skipped.
    })
    .catch((e: unknown) => {
      setLspStatus({ state: "failed", dir, detail: errorMessage(e) });
      console.warn("rust-analyzer workspace switch failed", e);
    });
}

async function startRustAnalyzer(dir: string): Promise<() => void> {
  const monaco = await loadMonaco();
  const started = await invoke<number>("lsp_start", { dir });
  if (started.isErr()) throw new Error(errorMessage(started.error));
  const id = started.value;
  const reader = new TauriMessageReader(id);
  await reader.attach();
  const { MonacoLanguageClient } = await import("monaco-languageclient");
  const client = new MonacoLanguageClient({
    name: "rust-analyzer",
    clientOptions: {
      documentSelector: [{ language: "rust", scheme: "file" }],
      workspaceFolder: {
        // monaco.Uri IS vscode's URI class in this stack.
        uri: monaco.Uri.file(dir) as never,
        name: dir.split("/").pop() ?? dir,
        index: 0,
      },
    },
    messageTransports: {
      reader,
      writer: new TauriMessageWriter(id),
    },
  });
  try {
    await client.start();
  } catch (e) {
    void invoke("lsp_stop", { id });
    throw e;
  }
  return () => {
    void client.dispose().catch(() => {});
    void invoke("lsp_stop", { id });
  };
}
