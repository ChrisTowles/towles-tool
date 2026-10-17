import { useState } from "react";
import { GitBranchIcon } from "@phosphor-icons/react";
import { InputArea } from "@cloudflare/kumo";
import { sessionCatchesEye, sessionLabel, sessionStatusText } from "@/lib/agentboard/session";
import { Dot } from "@/components/agentboard-bits/status-dots";
import type { BoardAgentStatus } from "@/lib/board-agent-status";
import { repoAccentStyles, repoIcon, type RepoIdentity } from "@/lib/repo-identity";
import { cn } from "@/lib/utils";
import type { TaskItem } from "@/lib/data";

/** Seeded each time the menu opens (Base UI unmounts content on close) and
 * committed on blur, so the store isn't written per keystroke. */
export function NotesField({
  task,
  onSetNotes,
}: {
  task: TaskItem;
  onSetNotes: (id: number, notes: string) => void;
}) {
  const [draft, setDraft] = useState(task.notes ?? "");
  return (
    <InputArea
      size="xs"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() !== (task.notes ?? "").trim()) onSetNotes(task.id, draft);
      }}
      placeholder="Add notes…"
      rows={3}
      className="min-h-16 resize-none"
      aria-label="Todo notes"
    />
  );
}

export function LaneGlyph({ repo }: { repo?: RepoIdentity }) {
  if (!repo) {
    return <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  const Icon = repoIcon(repo.meta);
  return (
    <Icon
      aria-hidden
      className="size-3.5 shrink-0 text-muted-foreground"
      style={repoAccentStyles(repo).iconStyle}
    />
  );
}

/** The rail's own dot and word for the worktree's loudest session, reported as-is;
 * amber boxes it when that session needs you. A sibling of the identity button. */
export function AgentStatusChip({
  agent,
  onOpen,
}: {
  agent: BoardAgentStatus;
  onOpen: () => void;
}) {
  const { session, sessionCount } = agent;
  const needs = sessionCatchesEye(session);
  const others = sessionCount > 1 ? ` · ${sessionCount} sessions` : "";
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Open on Agentboard — ${sessionLabel(session)}${others}`}
      className={cn(
        "ml-auto flex shrink-0 items-center gap-1.5 rounded-sm px-1 font-sans not-italic hover:bg-accent hover:text-foreground",
        needs && "border border-warn/50 bg-warn/10 text-warn",
      )}
    >
      <Dot session={session} />
      {needs && <span className="size-1.5 shrink-0 rounded-full bg-warn" />}
      {sessionStatusText(session)}
    </button>
  );
}
