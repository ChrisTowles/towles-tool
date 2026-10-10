import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwiseIcon,
  DotsThreeIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { Button, DropdownMenu, Input, InputArea } from "@cloudflare/kumo";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
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

// Only the selected tab's panel renders, so the last answer lives here to survive a
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
      <div className="rounded-lg border border-kumo-hairline bg-kumo-base">
        <Empty>Saved queries live in the app's settings — open the desktop app.</Empty>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded-lg border border-kumo-hairline bg-kumo-base">
      <aside className="flex w-[180px] shrink-0 flex-col border-r border-kumo-hairline">
        <div className="flex items-center gap-1 border-b border-kumo-hairline p-2">
          <div className="relative min-w-0 flex-1">
            <MagnifyingGlassIcon className="absolute top-1/2 left-2 size-3 -translate-y-1/2 text-kumo-subtle" />
            <Input
              size="xs"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search"
              aria-label="Search queries"
              className="pl-6"
            />
          </div>
          <Button
            shape="square"
            size="sm"
            variant="ghost"
            className="shrink-0"
            aria-label="New query"
            icon={<PlusIcon className="size-3.5" />}
            onClick={addQuery}
          />
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
            <header className="flex shrink-0 items-center gap-2 border-b border-kumo-hairline px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-kumo-default">
                {selected.label}
              </span>
              <KbdGroup aria-hidden>
                {shortcutKeys("tq-run").map((cap) => (
                  <Kbd key={cap}>{cap}</Kbd>
                ))}
              </KbdGroup>
              <Button
                shape="square"
                size="sm"
                variant="ghost"
                aria-label="Reload the event log"
                icon={
                  <ArrowClockwiseIcon className={cn("size-3.5", reloading && "animate-spin")} />
                }
                onClick={() => void reload()}
                disabled={reloading || running}
              />
              <Button
                size="sm"
                variant="primary"
                icon={<PlayIcon className="size-3.5" />}
                onClick={() => {
                  mouseAction("tq-run", "telemetry");
                  void run();
                }}
                disabled={running}
              >
                Run
              </Button>
            </header>
            <InputArea
              value={selected.sql}
              onChange={(e) => setSql(selected.id, e.target.value)}
              onBlur={() => void flush()}
              spellCheck={false}
              aria-label="SQL"
              className="min-h-36 shrink-0 resize-y rounded-none border-0 border-b border-kumo-hairline font-mono text-xs leading-5 field-sizing-fixed focus-visible:ring-0 md:text-xs"
            />
            {error && (
              <p className="shrink-0 border-b border-kumo-hairline bg-red-500/5 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-red-600 dark:text-red-400">
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
          ? "bg-kumo-tint text-kumo-default"
          : "text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default",
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
        <DropdownMenu.Trigger
          render={
            <Button
              shape="square"
              size="xs"
              variant="ghost"
              className="mr-0.5 shrink-0 opacity-0 group-hover:opacity-100 data-[popup-open]:opacity-100"
              aria-label={`Actions for ${query.label}`}
              icon={<DotsThreeIcon className="size-3.5" />}
            />
          }
        />
        <DropdownMenu.Content align="end">
          <DropdownMenu.Item
            onClick={() => {
              uiAction("telemetry.query_rename_start", "telemetry");
              onStartRename();
            }}
          >
            Rename
          </DropdownMenu.Item>
          <DropdownMenu.Item variant="danger" onClick={onDelete}>
            Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
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
      size="xs"
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
                      "sticky top-0 border-b border-kumo-hairline bg-kumo-base px-2.5 py-1.5 text-left font-mono font-medium text-kumo-subtle",
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
                        "border-b border-kumo-hairline/50 px-2.5 py-1 align-top font-mono whitespace-nowrap",
                        numeric[c] && "text-right tabular-nums",
                        v === null && "text-kumo-subtle/50",
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
      <div className="shrink-0 border-t border-kumo-hairline px-3 py-1.5 font-mono text-[11px] text-kumo-subtle">
        {resultCaption(result)}
      </div>
    </div>
  );
}
