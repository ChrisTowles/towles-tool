import { useEffect, useMemo, useRef, useState } from "react";
import { Ellipsis, Play, Plus, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { Empty } from "@/components/store-bits";
import { errorMessage, NotInTauri } from "@/lib/errors";
import { nextSavedQueryId, useUserSettings, type SavedQuery } from "@/lib/settings";
import { mouseAction } from "@/lib/shortcut-coach";
import { shortcutKeys, useShortcuts } from "@/lib/shortcuts";
import {
  fmtCell,
  numericColumns,
  resultCaption,
  telemetryQuery,
  telemetryQueryReload,
  type QueryResult,
} from "@/lib/telemetry";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

/** Query — SQL over the last fortnight of the event log (`tt_telemetry::query`):
 * the "next incident is a jq query" from docs/TELEMETRY.md, run in the app.
 * Saved queries are user settings, so they follow the user across checkouts. */

const NEW_QUERY_SQL =
  "select ts, kind, name, message, duration_ms, tt_task\nfrom records\nwhere day = date('now')\norder by ts desc\nlimit 100";

// Radix drops a hidden TabsContent, so the last answer lives here to survive a
// trip to the Log tab and back.
let remembered: { selectedId: string | null; result: QueryResult | null; error: string | null } = {
  selectedId: null,
  result: null,
  error: null,
};

export function QueryTab() {
  const { activeTab } = useWorkspace();
  const { settings, loaded, update, flush } = useUserSettings();
  const queries = settings?.savedQueries ?? [];
  const [selectedId, setSelectedId] = useState(remembered.selectedId);
  const [result, setResult] = useState(remembered.result);
  const [error, setError] = useState(remembered.error);
  const [running, setRunning] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [filter, setFilter] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    remembered = { selectedId, result, error };
  }, [selectedId, result, error]);

  const selected = queries.find((q) => q.id === selectedId) ?? queries[0] ?? null;
  const needle = filter.trim().toLowerCase();
  const shown = needle ? queries.filter((q) => q.label.toLowerCase().includes(needle)) : queries;

  async function run() {
    if (!selected || running) return;
    void flush();
    setRunning(true);
    const r = await telemetryQuery(selected.sql);
    r.match({
      ok: (res) => {
        setResult(res);
        setError(null);
      },
      err: (e) => {
        if (!NotInTauri.is(e)) setError(errorMessage(e));
      },
    });
    setRunning(false);
  }

  // The binding's handler is memoized once; the ref keeps it on the live `run`.
  const runRef = useRef(run);
  runRef.current = run;
  useShortcuts(
    useMemo(() => ({ "tq-run": () => void runRef.current() }), []),
    "telemetry",
    activeTab === "telemetry",
  );

  async function reload() {
    uiAction("telemetry.query_reload", "telemetry");
    setReloading(true);
    const r = await telemetryQueryReload();
    setReloading(false);
    if (r.isErr()) {
      if (!NotInTauri.is(r.error)) setError(errorMessage(r.error));
      return;
    }
    await run();
  }

  function setSql(id: string, sql: string) {
    update(
      (s) => ({ ...s, savedQueries: s.savedQueries.map((q) => (q.id === id ? { ...q, sql } : q)) }),
      { defer: true },
    );
  }

  function addQuery() {
    if (!settings) return;
    const id = nextSavedQueryId(settings.savedQueries, "Untitled query");
    update((s) => ({
      ...s,
      savedQueries: [...s.savedQueries, { id, label: "Untitled query", sql: NEW_QUERY_SQL }],
    }));
    setSelectedId(id);
    setRenaming(id);
    uiAction("telemetry.query_saved", "telemetry", "new");
  }

  function rename(id: string, label: string) {
    setRenaming(null);
    const trimmed = label.trim();
    if (!trimmed) return;
    update((s) => ({
      ...s,
      savedQueries: s.savedQueries.map((q) => (q.id === id ? { ...q, label: trimmed } : q)),
    }));
    uiAction("telemetry.query_saved", "telemetry", "rename");
  }

  function remove(id: string) {
    update((s) => ({ ...s, savedQueries: s.savedQueries.filter((q) => q.id !== id) }));
    if (selectedId === id) setSelectedId(null);
    uiAction("telemetry.query_deleted", "telemetry");
  }

  function select(id: string) {
    setSelectedId(id);
    uiAction("telemetry.query_selected", "telemetry");
  }

  if (loaded && !settings) {
    return (
      <div className="rounded-lg border border-border bg-card">
        <Empty>Saved queries live in the app's settings — open the desktop app.</Empty>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded-lg border border-border bg-card">
      <aside className="flex w-[180px] shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-1 border-b border-border p-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search"
              className="h-7 pl-6 text-xs"
            />
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            aria-label="New query"
            onClick={addQuery}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
          {shown.map((q) => (
            <QueryRow
              key={q.id}
              query={q}
              active={selected?.id === q.id}
              renaming={renaming === q.id}
              onSelect={() => select(q.id)}
              onRename={(label) => rename(q.id, label)}
              onStartRename={() => setRenaming(q.id)}
              onDelete={() => remove(q.id)}
            />
          ))}
          {shown.length === 0 && (
            <Empty inline>{queries.length === 0 ? "No saved queries." : "No match."}</Empty>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {selected.label}
              </span>
              <KbdGroup aria-hidden>
                {shortcutKeys("tq-run").map((cap) => (
                  <Kbd key={cap}>{cap}</Kbd>
                ))}
              </KbdGroup>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label="Reload the event log"
                onClick={() => void reload()}
                disabled={reloading || running}
              >
                <RefreshCw className={cn("size-3.5", reloading && "animate-spin")} />
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  mouseAction("tq-run", "telemetry");
                  void run();
                }}
                disabled={running}
              >
                <Play className="size-3.5" />
                Run
              </Button>
            </header>
            <Textarea
              value={selected.sql}
              onChange={(e) => setSql(selected.id, e.target.value)}
              onBlur={() => void flush()}
              spellCheck={false}
              aria-label="SQL"
              className="min-h-36 shrink-0 resize-y rounded-none border-0 border-b border-border font-mono text-xs leading-5 field-sizing-fixed focus-visible:ring-0 md:text-xs"
            />
            {error && (
              <p className="shrink-0 border-b border-border bg-red-500/5 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <ResultsGrid result={result} running={running} />
          </>
        ) : (
          <Empty>{loaded ? "Add a query with + to start." : "Loading saved queries…"}</Empty>
        )}
      </section>
    </div>
  );
}

function QueryRow({
  query,
  active,
  renaming,
  onSelect,
  onRename,
  onStartRename,
  onDelete,
}: {
  query: SavedQuery;
  active: boolean;
  renaming: boolean;
  onSelect: () => void;
  onRename: (label: string) => void;
  onStartRename: () => void;
  onDelete: () => void;
}) {
  if (renaming) return <RenameInput initial={query.label} onDone={onRename} />;
  return (
    <div
      className={cn(
        "group flex items-center rounded-md",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs"
        title={query.label}
      >
        {query.label}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="mr-0.5 size-6 shrink-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
            aria-label={`Actions for ${query.label}`}
          >
            <Ellipsis className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onStartRename}>Rename</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Commits on blur, so Enter (blur) and Escape (revert, then blur) report once. */
function RenameInput({ initial, onDone }: { initial: string; onDone: (label: string) => void }) {
  const cancelled = useRef(false);
  return (
    <Input
      autoFocus
      defaultValue={initial}
      aria-label="Query name"
      className="h-7 text-xs"
      onBlur={(e) => onDone(cancelled.current ? initial : e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") cancelled.current = true;
        if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
      }}
    />
  );
}

function ResultsGrid({ result, running }: { result: QueryResult | null; running: boolean }) {
  const numeric = useMemo(() => (result ? numericColumns(result) : []), [result]);
  if (!result) {
    return (
      <div className="flex-1">
        <Empty>{running ? "Running…" : "Run the query to see rows here."}</Empty>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn("min-h-0 flex-1 overflow-auto", running && "opacity-60")}>
        {result.rows.length === 0 ? (
          <Empty>No rows.</Empty>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                {result.columns.map((c, i) => (
                  <th
                    key={`${c}-${i}`}
                    className={cn(
                      "sticky top-0 border-b border-border bg-card px-2.5 py-1.5 text-left font-mono font-medium text-muted-foreground",
                      numeric[i] && "text-right",
                    )}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, r) => (
                <tr key={r} className="hover:bg-accent/40">
                  {row.map((v, c) => (
                    <td
                      key={c}
                      className={cn(
                        "border-b border-border/50 px-2.5 py-1 align-top font-mono whitespace-nowrap",
                        numeric[c] && "text-right tabular-nums",
                        v === null && "text-muted-foreground/50",
                      )}
                    >
                      <div className="max-w-[56ch] truncate" title={fmtCell(v)}>
                        {fmtCell(v)}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="shrink-0 border-t border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        {resultCaption(result)}
      </div>
    </div>
  );
}
