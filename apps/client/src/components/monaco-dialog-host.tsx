import { useSyncExternalStore } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { dialogStore } from "@/lib/monaco-dialog-store";

/** Renders the confirmations the VS Code layer asks for. Mounted once at the app
 * root: the workbench raises them from anywhere. The alternative is VS Code's own
 * `window.confirm()`, which freezes the Tauri window outright. */
export function MonacoDialogHost() {
  const pending = useSyncExternalStore(dialogStore.subscribe, dialogStore.get);
  // One at a time — the workbench raises these serially, and stacking modals
  // would make it ambiguous which one a keypress answers.
  const req = pending[0];
  if (!req) return null;
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        // Escape / overlay click is a decline, not a dismissal — the
        // workbench is awaiting an answer either way.
        if (!open) dialogStore.answer(req.id, false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{req.message}</AlertDialogTitle>
          {req.detail && <AlertDialogDescription>{req.detail}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => dialogStore.answer(req.id, false)}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant={req.danger ? "destructive" : "default"}
            onClick={() => dialogStore.answer(req.id, true)}
          >
            {req.primary}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
