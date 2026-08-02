// Stays a real <textarea> — the form leans on image paste, drag-drop, Cmd+Enter
// and native undo. So highlighting is an aria-hidden mirror div behind
// transparent text, and the two must keep identical metrics or the colours slide.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Textarea } from "@/components/ui/textarea";
import {
  highlightSegments,
  applyMention,
  insertMentionTrigger,
  matchIssues,
  mentionQueryAt,
} from "@/lib/goal-text";
import type { IssueItem } from "@/lib/data";
import { cn } from "@/lib/utils";

/** `md:text-xs` is not redundant: tailwind-merge dedupes only within a modifier,
 * so a bare `text-xs` loses to shadcn's `md:text-sm` above 768px and the caret
 * drifts further from the mirror with every character typed. */
const SHARED_BOX = "px-2.5 py-2 text-xs leading-normal md:text-xs";

export function GoalEditor({
  value,
  onChange,
  onKeyDown,
  issues,
  issuesError,
  onNeedIssues,
  onPickIssue,
  hint,
  className,
  ...textareaProps
}: {
  value: string;
  onChange: (next: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** `null` while loading. */
  issues: IssueItem[] | null;
  issuesError: string | null;
  /** Fired the first time a `#` is typed, so `gh` is never shelled for a goal
   * that has no issue reference. */
  onNeedIssues: () => void;
  /** A picked issue also gets attached to the task; the reference text is
   * inserted here. */
  onPickIssue: (issue: IssueItem) => void;
  hint?: ReactNode;
  className?: string;
} & Omit<React.ComponentProps<"textarea">, "value" | "onChange" | "onKeyDown">) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);

  const matches = mention && issues ? matchIssues(issues, mention.query).slice(0, 8) : [];
  const open = mention !== null;

  // Pin the mirror's scroll to the textarea's, or highlights lag once it scrolls.
  useLayoutEffect(() => {
    const el = ref.current;
    const m = mirror.current;
    if (el && m) m.scrollTop = el.scrollTop;
  }, [value]);

  function syncMention(el: HTMLTextAreaElement) {
    const found = mentionQueryAt(el.value, el.selectionStart ?? 0);
    setMention(found);
    setActive(0);
    if (found && issues === null) onNeedIssues();
  }

  function pick(issue: IssueItem) {
    const el = ref.current;
    if (!el || !mention) return;
    const next = applyMention(value, mention.start, el.selectionStart ?? 0, issue.number);
    onChange(next.text);
    onPickIssue(issue);
    setMention(null);
    // A caret set synchronously is overwritten by the controlled re-render.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  }

  /** Makes the feature discoverable by clicking, not only by typing `#`. */
  function startMention() {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const next = insertMentionTrigger(value, caret);
    onChange(next.text);
    if (issues === null) onNeedIssues();
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      setMention(mentionQueryAt(next.text, next.caret));
      setActive(0);
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <div
          ref={mirror}
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent whitespace-pre-wrap break-words",
            SHARED_BOX,
          )}
        >
          {/* Highlight styles may only change *paint*, never metrics: padding,
            margin, font-weight, letter-spacing or borders here would reflow the
            mirror out from under the textarea's caret. Colour, background and
            text-decoration are safe; a radius is too, with no border width. */}
          {highlightSegments(value).map((seg, i) => (
            <span
              key={i}
              className={
                seg.kind === "url"
                  ? "text-sky-600 underline decoration-sky-600/60 dark:text-sky-400 dark:decoration-sky-400/60"
                  : seg.kind === "ref"
                    ? "rounded bg-sky-500/20 text-sky-700 dark:text-sky-300"
                    : undefined
              }
            >
              {seg.text}
            </span>
          ))}
          {/* A trailing newline collapses without this, so the mirror ends one
            line short of the textarea while typing at the end. */}
          {value.endsWith("\n") ? " " : null}
        </div>
        <Textarea
          {...textareaProps}
          ref={ref}
          value={value}
          // Transparent text, visible caret: the mirror underneath has the glyphs.
          className={cn(
            "relative bg-transparent text-transparent caret-foreground",
            SHARED_BOX,
            className,
          )}
          onChange={(e) => {
            onChange(e.target.value);
            syncMention(e.target);
          }}
          onScroll={(e) => {
            if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onClick={(e) => syncMention(e.currentTarget)}
          onBlur={() => setMention(null)}
          onKeyDown={(e) => {
            // The form must not see these: Enter would submit, Escape would cancel.
            if (open && matches.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => (a + 1) % matches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => (a - 1 + matches.length) % matches.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pick(matches[active]);
                return;
              }
            }
            if (open && e.key === "Escape") {
              e.preventDefault();
              setMention(null);
              return;
            }
            onKeyDown?.(e);
          }}
          onKeyUp={(e) => syncMention(e.currentTarget)}
        />
        {open && (
          <div className="absolute top-full left-0 z-50 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-md">
            {issuesError ? (
              <p className="p-2 text-[11px] text-red-500">{issuesError}</p>
            ) : issues === null ? (
              <p className="p-2 text-[11px] text-muted-foreground">Loading issues…</p>
            ) : matches.length === 0 ? (
              <p className="p-2 text-[11px] text-muted-foreground">No matching issues.</p>
            ) : (
              matches.map((issue, i) => (
                <button
                  key={issue.number}
                  type="button"
                  // Blur would close the popup before a click lands.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(issue);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    "flex w-full items-baseline gap-2 px-2 py-1.5 text-left",
                    i === active && "bg-accent",
                  )}
                >
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                    #{issue.number}
                  </span>
                  <span className="truncate text-xs">{issue.title}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {/* Persistent, because the placeholder that used to carry this vanishes
          on the first keystroke — which is exactly when someone is composing a
          goal and might want to reference an issue. */}
      <p className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <button
          type="button"
          aria-label="Link an issue"
          // A click would blur the textarea, closing the mention we are opening.
          onMouseDown={(e) => {
            e.preventDefault();
            startMention();
          }}
          className="rounded bg-sky-500/20 px-1 font-mono text-sky-700 hover:bg-sky-500/35 dark:text-sky-300"
        >
          #
        </button>
        <span>to link an issue</span>
        {hint ? <span className="text-muted-foreground/70">· {hint}</span> : null}
      </p>
    </div>
  );
}
