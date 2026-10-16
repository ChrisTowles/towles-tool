import { createKumoToastManager } from "@cloudflare/kumo";

/** The app's one toast manager, mounted by `<Toasty>` in `App.tsx`. A module
 * singleton so non-React code (IPC callbacks, the shortcut coach) can toast. */
export const toastManager = createKumoToastManager();

type ToastOptions = {
  description?: string;
  timeout?: number;
  /** Trailing buttons, e.g. a retry. */
  actions?: { label: string; onClick: () => void }[];
};
type Variant = "default" | "success" | "error" | "info";

function show(variant: Variant) {
  return (title: string, { actions, ...options }: ToastOptions = {}) =>
    toastManager.add({
      title,
      variant,
      ...options,
      actions: actions?.map((a) => ({ children: a.label, onClick: a.onClick })),
    });
}

export const toast = Object.assign(show("default"), {
  success: show("success"),
  error: show("error"),
  info: show("info"),
});
