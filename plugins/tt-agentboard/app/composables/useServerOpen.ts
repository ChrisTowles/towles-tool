/**
 * Composable for opening assets via the local server.
 * Since AgentBoard runs on the user's machine, the server can directly
 * launch browsers, editors, and files — no need for client-side window.open().
 */
export function useServerOpen() {
  async function openUrl(url: string) {
    await $fetch("/api/open", { method: "POST", body: { type: "url", target: url } });
  }

  async function openInVscode(path: string) {
    await $fetch("/api/open", { method: "POST", body: { type: "vscode", target: path } });
  }

  async function openFile(path: string) {
    await $fetch("/api/open", { method: "POST", body: { type: "file", target: path } });
  }

  return { openUrl, openInVscode, openFile };
}
