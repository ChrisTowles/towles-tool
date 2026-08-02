import { Result } from "better-result";
import { IpcFailed, type IpcError } from "@/lib/errors";
import { isTauri } from "@/lib/tauri";

/** Open a URL in the OS default browser. In the Tauri shell a bare
 * `window.open` either no-ops or opens an in-app webview, so this routes
 * through the opener plugin; browser dev falls back to `window.open`. */
export async function openExternalUrl(url: string): Promise<Result<void, IpcError>> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener");
    return Result.ok(undefined);
  }
  return Result.tryPromise({
    try: async () => {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    },
    catch: (cause): IpcError => new IpcFailed({ command: "opener.openUrl", cause }),
  });
}
