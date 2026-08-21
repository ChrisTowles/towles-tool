/** Dialog service for the VS Code layer. **Nothing here may ever call
 * `window.confirm`/`alert`/`prompt`** — inside the Tauri WebView a blocking
 * native dialog spins a nested GTK loop mid-IPC and wedges the window, which is
 * the whole reason this override exists. */

import { toast } from "sonner";
import { IDialogService } from "@codingame/monaco-vscode-api";
import { Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { isDangerous, stripMnemonic } from "@/lib/monaco-dialog-copy";
import { dialogStore } from "@/lib/monaco-dialog-store";

class AppDialogService {
  readonly onWillShowDialog = Event.None;
  readonly onDidShowDialog = Event.None;

  async confirm(confirmation: { message?: string; detail?: string; primaryButton?: string }) {
    const message = confirmation?.message ?? "Are you sure?";
    const detail = confirmation?.detail;
    const primary = stripMnemonic(confirmation?.primaryButton ?? "OK");
    const confirmed = await dialogStore.ask({
      message,
      detail,
      primary,
      danger: isDangerous(primary, message),
    });
    return { confirmed, checkboxChecked: false };
  }

  /** Only the first (primary) button is offered, keeping one ask-protocol. */
  async prompt(prompt: {
    message?: string;
    detail?: string;
    buttons?: { label?: string; run?: (ctx: { checkboxChecked: boolean }) => unknown }[];
    cancelButton?: unknown;
  }) {
    const first = prompt?.buttons?.[0];
    const { confirmed } = await this.confirm({
      message: prompt?.message,
      detail: prompt?.detail,
      primaryButton: first?.label,
    });
    return { result: confirmed ? await first?.run?.({ checkboxChecked: false }) : undefined };
  }

  // Toasts: console-only made a failed workbench action look like a no-op.
  async info(message: string, detail?: string) {
    this.notify("info", message, detail);
  }

  async warn(message: string, detail?: string) {
    this.notify("warning", message, detail);
  }

  async error(message: string, detail?: string) {
    this.notify("error", message, detail);
  }

  private notify(level: "info" | "warning" | "error", message: string, detail?: string) {
    toast[level](detail ? `${message} — ${detail}` : message);
  }

  /** No host for text input yet; decline rather than invent a value. */
  async input() {
    console.warn("[monaco] declined an input dialog — no host for it");
    return { confirmed: false, values: undefined };
  }

  async about() {}
}

export default function getServiceOverride(): Record<string, unknown> {
  return { [IDialogService.toString()]: new AppDialogService() };
}
