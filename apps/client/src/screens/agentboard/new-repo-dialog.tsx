import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NotInTauri } from "@/lib/errors";
import { invoke } from "@/lib/tauri";
import { cloneDirName } from "@/lib/new-repo";
import { uiAction } from "@/lib/ui-action";

export type NewRepoMode = "create" | "clone";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium">
      {label}
      {children}
    </label>
  );
}

export function NewRepoDialog({
  mode,
  parentDirs,
  onClose,
}: {
  mode: NewRepoMode | null;
  parentDirs: string[];
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={mode !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        {mode && (
          <NewRepoForm
            key={mode}
            mode={mode}
            defaultParent={parentDirs[0] ?? "~/code"}
            parentDirs={parentDirs}
            busy={busy}
            setBusy={setBusy}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewRepoForm({
  mode,
  defaultParent,
  parentDirs,
  busy,
  setBusy,
  onClose,
}: {
  mode: NewRepoMode;
  defaultParent: string;
  parentDirs: string[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [parent, setParent] = useState(defaultParent);

  const clone = mode === "clone";
  const effectiveName = clone ? name.trim() || cloneDirName(source) : name.trim();
  const ready = parent.trim() !== "" && effectiveName !== "" && (!clone || source.trim() !== "");
  const target = `${parent.trim().replace(/\/+$/, "")}/${effectiveName || "…"}`;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    const result = clone
      ? await invoke<string>("ab_clone_repo", { source, parent, name: name.trim() || null })
      : await invoke<string>("ab_create_repo", { parent, name: effectiveName });
    setBusy(false);
    if (result.isErr()) {
      if (!NotInTauri.is(result.error)) {
        toast.error(
          `Couldn't ${clone ? "clone" : "create"} ${effectiveName} — ${result.error.message}`,
        );
      }
      return;
    }
    uiAction(clone ? "repo.cloned" : "repo.created", "agentboard");
    toast.success(`${clone ? "Cloned" : "Created"} ${result.value} — it's on the rail`);
    onClose();
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{clone ? "Clone a repo from GitHub" : "Create a new repo"}</DialogTitle>
        <DialogDescription>
          {clone
            ? "Clones it with your git credentials and adds it to the rail."
            : "Runs git init with an empty first commit on main, then adds it to the rail."}
        </DialogDescription>
      </DialogHeader>
      {clone && (
        <Field label="Repository">
          <Input
            autoFocus
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="owner/repo or https://github.com/owner/repo"
            spellCheck={false}
          />
        </Field>
      )}
      <Field label={clone ? "Folder name (optional)" : "Name"}>
        <Input
          autoFocus={!clone}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={clone ? cloneDirName(source) || "same as the repo" : "my-project"}
          spellCheck={false}
        />
      </Field>
      <Field label="Location">
        <Input
          value={parent}
          onChange={(e) => setParent(e.target.value)}
          list="new-repo-parents"
          spellCheck={false}
        />
        <datalist id="new-repo-parents">
          {parentDirs.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
      </Field>
      <p className="truncate font-mono text-[11px] text-muted-foreground">→ {target}</p>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready || busy}>
          {busy ? (clone ? "Cloning…" : "Creating…") : clone ? "Clone" : "Create"}
        </Button>
      </DialogFooter>
    </form>
  );
}
