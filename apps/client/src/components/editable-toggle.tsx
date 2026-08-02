import { Lock, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";

/** The read-only ⇄ editable switch both Monaco surfaces carry. They default to
 * read-only because they're read while an agent works, often with the keyboard
 * focused in them, and a stray keystroke used to auto-save itself to disk. */
export function EditableToggle({
  editable,
  onChange,
  /** What the toggle unlocks, for the tooltip ("this file", "the changed files"). */
  subject,
}: {
  editable: boolean;
  onChange: (editable: boolean) => void;
  subject: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={editable}
      title={
        editable
          ? `Editing ${subject} — edits auto-save after a pause (⌘S saves now); click to lock`
          : `Read-only — keystrokes can't change ${subject}; click to edit`
      }
      onClick={() => onChange(!editable)}
      className={cn(
        // `whitespace-nowrap`: a narrow pane squeezes this grid column, and a
        // wrapped two-line lock is a worse target than one pushing its neighbors.
        "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] transition-colors",
        editable
          ? "border-amber-500/60 text-amber-500"
          : "border-border/70 text-muted-foreground hover:text-foreground",
      )}
    >
      {editable ? <Pencil className="size-3" /> : <Lock className="size-3" />}
      {editable ? "editable" : "read-only"}
    </button>
  );
}
