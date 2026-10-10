import { createKumoToastManager } from "@cloudflare/kumo";

/** The app's one toast manager, mounted by `<Toasty>` in `App.tsx`. A module
 * singleton so non-React code (IPC callbacks, the shortcut coach) can toast. */
export const toastManager = createKumoToastManager();

type ToastOptions = {
  description?: string;
  timeout?: number;
  /** One trailing button, e.g. a retry. */
  action?: { label: string; onClick: () => void };
};
type Variant = "default" | "success" | "error" | "info";

function show(variant: Variant) {
  return (title: string, { action, ...options }: ToastOptions = {}) =>
    toastManager.add({
      title,
      variant,
      ...options,
      actions: action ? [{ children: action.label, onClick: action.onClick }] : undefined,
    });
}

export const toast = Object.assign(show("default"), {
  success: show("success"),
  error: show("error"),
  info: show("info"),
});
