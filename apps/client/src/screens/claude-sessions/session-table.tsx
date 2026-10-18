import { Result } from "effect";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownIcon,
  ArrowsDownUpIcon,
  ArrowUpIcon,
  CheckIcon,
  CodeBlockIcon,
  CopyIcon,
} from "@phosphor-icons/react";
import { Button, Dialog, Tooltip } from "@cloudflare/kumo";
import {
  claudeSessionsBreakdown,
  type ClaudeSession,
  type SessionBreakdown,
} from "@/lib/claude-sessions";
import { requestAgentboardNav } from "@/lib/agentboard/requests";
import { uiAction } from "@/lib/ui-action";
import { useClipboardCopy } from "@/lib/use-clipboard-copy";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";
import { fmtTokens, fmtUsd } from "@/lib/format";
import { ProjectName, reportSessionsError, toolColor } from "@/screens/claude-sessions/shared";

/** A session whose in+out volume is ≥ this multiple of the visible median gets
 * the amber outlier treatment — "this one is not like the others". */
const OUTLIER_FACTOR = 5;

type SessionSortKey =
  | "title"
  | "project"
  | "date"
  | "billable"
  | "cacheRead"
  | "cacheWrite"
  | "cost";
type SortDir = "asc" | "desc";

/** First-click direction per column: names/repos alphabetize ascending; dates
 * and token volumes lead with the most recent/largest — the more useful
 * default for a table you opened to spot outliers. */
const DEFAULT_SORT_DIR: Record<SessionSortKey, SortDir> = {
  title: "asc",
  project: "asc",
  date: "desc",
  billable: "desc",
  cacheRead: "desc",
  cacheWrite: "desc",
  cost: "desc",
};

function sessionSortValue(s: ClaudeSession, key: SessionSortKey): string | number {
  switch (key) {
    case "title":
      return (s.title ?? s.sessionId).toLowerCase();
    case "project":
      return s.project.toLowerCase();
    case "date":
      return s.date;
    case "billable":
      return s.inputTokens + s.outputTokens;
    case "cacheRead":
      return s.cacheReadTokens;
    case "cacheWrite":
      return s.cacheCreationTokens;
    case "cost":
      return s.costUsd;
  }
}

function SortableTh({
  sortKey,
  active,
  dir,
  align = "left",
  onSort,
  children,
}: {
  sortKey: SessionSortKey;
  active: boolean;
  dir: SortDir;
  align?: "left" | "right";
  onSort: (key: SessionSortKey) => void;
  children: React.ReactNode;
}) {
  return (
    <th
      className={cn(
        "cursor-pointer select-none py-1.5 pr-3 font-medium hover:text-foreground",
        align === "right" && "text-right",
      )}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      onClick={() => onSort(sortKey)}
    >
      <span
        className={cn("inline-flex items-center gap-1", align === "right" && "flex-row-reverse")}
      >
        {children}
        {active ? (
          dir === "asc" ? (
            <ArrowUpIcon className="size-3" />
          ) : (
            <ArrowDownIcon className="size-3" />
          )
        ) : (
          <ArrowsDownUpIcon className="size-3 opacity-30" />
        )}
      </span>
    </th>
  );
}

/** Icon buttons to copy a session's ID and transcript file path — the two
 * things needed to point Claude at a specific session file — and to resume it
 * in the editor. Shared by the Sessions table, Insights cards, and the
 * breakdown dialog header. */
export function SessionButtons({ session }: { session: ClaudeSession }) {
  const { copiedKey, copy } = useClipboardCopy();
  const { openTab } = useWorkspace();
  const { cwd } = session;

  return (
    <span className="inline-flex items-center gap-0.5">
      {cwd && !session.programmatic && (
        <Tooltip
          content="Open in editor"
          render={
            <Button
              variant="ghost"
              size="xs"
              shape="square"
              aria-label="Open in editor"
              icon={<CodeBlockIcon className="size-3.5" />}
              onClick={(e) => {
                e.stopPropagation();
                uiAction("claude_sessions.open_in_editor", "claude-sessions");
                openTab("agentboard");
                requestAgentboardNav({
                  kind: "open-claude-session",
                  folderDir: cwd,
                  sessionId: session.sessionId,
                });
              }}
            />
          }
        />
      )}
      <Tooltip
        content="Copy session ID"
        render={
          <Button
            variant="ghost"
            size="xs"
            shape="square"
            aria-label="Copy session ID"
            icon={
              copiedKey === "id" ? (
                <CheckIcon className="size-3.5 text-ok" />
              ) : (
                <CopyIcon className="size-3.5" />
              )
            }
            onClick={(e) => {
              e.stopPropagation();
              uiAction("claude_sessions.copy", "claude-sessions", "id");
              copy("id", session.sessionId);
            }}
          />
        }
      />
      <Tooltip
        content="Copy session file path"
        render={
          <Button
            variant="ghost"
            size="xs"
            shape="square"
            aria-label="Copy session file path"
            icon={
              copiedKey === "path" ? (
                <CheckIcon className="size-3.5 text-ok" />
              ) : (
                <CopyIcon className="size-3.5" />
              )
            }
            onClick={(e) => {
              e.stopPropagation();
              uiAction("claude_sessions.copy", "claude-sessions", "path");
              copy("path", session.path);
            }}
          />
        }
      />
    </span>
  );
}

/** One horizontal magnitude bar, scaled against the section's max. */
function TokenBar({ color, fraction }: { color: string; fraction: number }) {
  return (
    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full"
        style={{ width: `${Math.max(2, fraction * 100)}%`, background: color }}
      />
    </div>
  );
}

/** Turn/tool drill-down for one session — fetched on open, the only
 * per-session re-parse in the screen. */
export function BreakdownDialog({
  session,
  onClose,
}: {
  session: ClaudeSession | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<SessionBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const sessionId = session?.sessionId;

  useEffect(() => {
    if (!sessionId) return;
    setData(null);
    setLoading(true);
    void claudeSessionsBreakdown(sessionId).then((r) => {
      Result.match(r, { onSuccess: setData, onFailure: reportSessionsError });
      setLoading(false);
    });
  }, [sessionId]);

  const topTools = data?.tools.slice(0, 10) ?? [];
  const maxTool = Math.max(1, ...topTools.map((t) => t.inputTokens + t.outputTokens));
  const topTurns = [...(data?.turns ?? [])]
    .toSorted((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
    .slice(0, 10);
  const maxTurn = Math.max(1, ...topTurns.map((t) => t.inputTokens + t.outputTokens));

  return (
    <Dialog.Root open={!!session} onOpenChange={(o) => !o && onClose()}>
      <Dialog size="xl" className="max-h-[85vh] overflow-y-auto p-6">
        <div className="mb-4 flex flex-col gap-1.5">
          <Dialog.Title className="flex items-center gap-2 pr-6 text-lg">
            <span className="min-w-0 truncate">
              {session?.title ?? session?.sessionId.slice(0, 8)}
            </span>
            {session && <SessionButtons session={session} />}
          </Dialog.Title>
          <Dialog.Description className="text-sm">
            {session && <ProjectName name={session.project} />} · {session?.date} ·{" "}
            {fmtTokens((session?.inputTokens ?? 0) + (session?.outputTokens ?? 0))} in+out
          </Dialog.Description>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Parsing session…</p>
        ) : data ? (
          <div className="flex flex-col gap-5">
            <section>
              <h4 className="mb-2 text-mini font-medium uppercase tracking-wider text-muted-foreground">
                Where the tokens went
              </h4>
              {topTools.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tool calls recorded.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {topTools.map((t) => (
                    <div key={t.name} className="flex items-center gap-2 text-sm">
                      <span
                        className="size-2.5 shrink-0 rounded-[3px]"
                        style={{ background: toolColor(t.name) }}
                      />
                      <span className="w-40 truncate text-foreground">{t.name}</span>
                      <span className="w-10 shrink-0 text-right font-mono text-xs text-muted-foreground">
                        {t.detail}
                      </span>
                      <TokenBar
                        color={toolColor(t.name)}
                        fraction={(t.inputTokens + t.outputTokens) / maxTool}
                      />
                      <span className="w-14 shrink-0 text-right font-mono text-xs text-muted-foreground">
                        {fmtTokens(t.inputTokens + t.outputTokens)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h4 className="mb-2 text-mini font-medium uppercase tracking-wider text-muted-foreground">
                Heaviest steps
              </h4>
              {topTurns.length === 0 ? (
                <p className="text-sm text-muted-foreground">No token-bearing steps.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {topTurns.map((t, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <span
                        className="size-2.5 shrink-0 rounded-[3px]"
                        style={{ background: toolColor(t.toolName) }}
                      />
                      <span className="w-52 truncate text-foreground" title={t.name}>
                        {t.name}
                      </span>
                      <TokenBar
                        color={toolColor(t.toolName)}
                        fraction={(t.inputTokens + t.outputTokens) / maxTurn}
                      />
                      <span className="w-14 shrink-0 text-right font-mono text-xs text-muted-foreground">
                        {fmtTokens(t.inputTokens + t.outputTokens)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {data.turns.length > topTurns.length && (
                <p className="mt-1.5 text-mini text-muted-foreground">
                  Top {topTurns.length} of {data.turns.length} token-bearing steps.
                </p>
              )}
            </section>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Could not load this session.</p>
        )}
      </Dialog>
    </Dialog.Root>
  );
}

export function SessionTable({
  sessions,
  searching,
}: {
  sessions: ClaudeSession[];
  searching: boolean;
}) {
  const [sort, setSort] = useState<{ key: SessionSortKey; dir: SortDir } | null>(null);
  const [breakdownFor, setBreakdownFor] = useState<ClaudeSession | null>(null);

  const medianBillable = useMemo(() => {
    const sorted = sessions.map((s) => s.inputTokens + s.outputTokens).toSorted((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  }, [sessions]);

  const rows = useMemo(() => {
    if (!sort) return sessions;
    const { key, dir } = sort;
    return [...sessions].toSorted((a, b) => {
      const av = sessionSortValue(a, key);
      const bv = sessionSortValue(b, key);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return dir === "asc" ? cmp : -cmp;
    });
  }, [sessions, sort]);

  const toggleSort = (key: SessionSortKey) => {
    uiAction("claude_sessions.sort", "claude-sessions", key);
    setSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: DEFAULT_SORT_DIR[key] },
    );
  };

  if (sessions.length === 0)
    return (
      <p className="px-1 py-3 text-sm text-muted-foreground">
        {searching ? "No sessions match." : "No sessions in this range."}
      </p>
    );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-mini uppercase tracking-wider text-muted-foreground">
            <SortableTh
              sortKey="title"
              active={sort?.key === "title"}
              dir={sort?.dir ?? "asc"}
              onSort={toggleSort}
            >
              Session
            </SortableTh>
            <SortableTh
              sortKey="project"
              active={sort?.key === "project"}
              dir={sort?.dir ?? "asc"}
              onSort={toggleSort}
            >
              Repo
            </SortableTh>
            <SortableTh
              sortKey="date"
              active={sort?.key === "date"}
              dir={sort?.dir ?? "desc"}
              onSort={toggleSort}
            >
              Date
            </SortableTh>
            <SortableTh
              sortKey="billable"
              active={sort?.key === "billable"}
              dir={sort?.dir ?? "desc"}
              align="right"
              onSort={toggleSort}
            >
              In+Out
            </SortableTh>
            <SortableTh
              sortKey="cacheRead"
              active={sort?.key === "cacheRead"}
              dir={sort?.dir ?? "desc"}
              align="right"
              onSort={toggleSort}
            >
              Cache R
            </SortableTh>
            <SortableTh
              sortKey="cacheWrite"
              active={sort?.key === "cacheWrite"}
              dir={sort?.dir ?? "desc"}
              align="right"
              onSort={toggleSort}
            >
              Cache W
            </SortableTh>
            <SortableTh
              sortKey="cost"
              active={sort?.key === "cost"}
              dir={sort?.dir ?? "desc"}
              align="right"
              onSort={toggleSort}
            >
              Cost
            </SortableTh>
            <th className="py-1.5 pl-3 font-medium" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const billable = s.inputTokens + s.outputTokens;
            const outlier = medianBillable > 0 && billable >= OUTLIER_FACTOR * medianBillable;
            return (
              <tr
                key={s.sessionId}
                className="cursor-pointer border-b border-border/60 hover:bg-accent/50"
                onClick={() => {
                  uiAction("claude_sessions.breakdown_open", "claude-sessions", "table");
                  setBreakdownFor(s);
                }}
              >
                <td className="max-w-[340px] py-1.5 pr-3">
                  <div className="truncate text-foreground">
                    {s.title ?? (
                      <span className="font-mono text-xs">{s.sessionId.slice(0, 8)}</span>
                    )}
                  </div>
                  {s.snippet && (
                    <div className="truncate text-mini text-muted-foreground">{s.snippet}</div>
                  )}
                </td>
                <td className="py-1.5 pr-3 font-mono text-xs text-muted-foreground">
                  <ProjectName name={s.project} />
                </td>
                <td className="py-1.5 pr-3 font-mono text-xs text-muted-foreground">{s.date}</td>
                <td
                  className={cn(
                    "py-1.5 pr-3 text-right font-mono text-xs",
                    outlier ? "font-semibold text-warn" : "text-foreground",
                  )}
                >
                  {fmtTokens(billable)}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono text-xs text-muted-foreground">
                  {fmtTokens(s.cacheReadTokens)}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono text-xs text-muted-foreground">
                  {fmtTokens(s.cacheCreationTokens)}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono text-xs text-foreground">
                  {fmtUsd(s.costUsd)}
                </td>
                <td className="py-1.5 pl-3 text-right">
                  <SessionButtons session={s} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <BreakdownDialog session={breakdownFor} onClose={() => setBreakdownFor(null)} />
    </div>
  );
}
