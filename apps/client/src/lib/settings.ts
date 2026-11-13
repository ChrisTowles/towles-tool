import {
  PromptImproverListSchema,
  SavedQueryListSchema,
  TelemetryRuleListSchema,
  UserSettingsSchema,
} from "./schemas/settings";
import { Effect, Result } from "effect";
import * as Atom from "effect/reactivity/Atom";
import { useAtomValue } from "./atoms/react";
import { feed } from "./atoms/feed";
import { read, write } from "./atoms/registry";
import { invoke, runIpc } from "./tauri";
import { slugify } from "./slug";
import type { Filter, RuleKind } from "./telemetry";
import type { UpdateChannel } from "./update";

/** Client-side view of the shared user settings (`crates/tt-config`), co-owned
 * by the TS CLI — so a save carries the whole object forward. */

/** Ordered; a kind fires at or above `agentboard.notifyThreshold`. */
export type NotifyLevel = "routine" | "important" | "urgent";

/** The kind→level mapping is Rust's `NotifyKind::level`. */
export const NOTIFY_LEVELS: { value: NotifyLevel; label: string; description: string }[] = [
  {
    value: "routine",
    label: "Everything",
    description: "Also review requests and collectors that stopped refreshing.",
  },
  {
    value: "important",
    label: "Important and up",
    description: "Meetings, agents needing you, and your own PRs' CI failing.",
  },
  { value: "urgent", label: "Urgent only", description: "Meetings and agents needing you." },
];

/** Mirrors Rust's `tt_config::DEFAULT_NOTIFY_THRESHOLD`. */
export const DEFAULT_NOTIFY_THRESHOLD: NotifyLevel = "routine";

/** Not a scale: `"active"` is what's running now, `"recent"` is where you
 * worked within `railRecentHours`. */
export type RailFilter = "all" | "active" | "recent";

/** Mirrors `tt_config::RailSort`. `"manual"` is the Repos drag order for repos
 * and creation order for tasks. */
export type RailSort = "manual" | "name" | "recent";

type JournalSettings = {
  baseFolder: string;
  dailyPathTemplate: string;
  meetingPathTemplate: string;
  notePathTemplate: string;
  templateDir: string;
};

/** Weekdays: 0 = Monday … 6 = Sunday. */
type CalendarQuietHours = {
  enabled: boolean;
  startHour: number;
  endHour: number;
  weekdays: number[];
};

/** `id` is the store lane a pull replaces, so it must stay stable. */
export type CalendarSource = {
  id: string;
  label: string;
  enabled: boolean;
  prompt: string;
};

/** Suffixed until free; a source can be removed and re-added. */
export function nextCalendarSourceId(sources: CalendarSource[], label: string): string {
  const taken = new Set(sources.map((s) => s.id));
  // The shared slug rule, not a second regex — this key is permanent.
  const base = slugify(label) || "calendar";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** One button in the new-task form that rewrites the goal before the task
 * starts. `prompt` is an instruction *about* the goal, not a template. */
export type PromptImprover = {
  id: string;
  label: string;
  enabled: boolean;
  preferred: boolean;
  prompt: string;
};

/** Permanent key, as {@link nextCalendarSourceId}. */
export function nextPromptImproverId(improvers: PromptImprover[], label: string): string {
  const taken = new Set(improvers.map((t) => t.id));
  const base = slugify(label) || "improver";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A new-task preset — `tt_config::TaskTemplate`. Empty fields mean "none"; an
 * empty `repo` offers it for every repo. */
export type TaskTemplate = {
  id: string;
  label: string;
  repo: string;
  goal: string;
  improver: string;
  setup: string;
};

/** Read from `tt_config` — a second copy of prompts this long drifts. */
export function defaultPromptImprovers() {
  return runIpc(
    invoke<PromptImprover[]>(
      "settings_default_prompt_improvers",
      {},
      { schema: PromptImproverListSchema },
    ),
  );
}

/** Restores the built-ins **in place** — a missing one is appended, and an
 * improver the user added of their own is untouched. */
export function withDefaultPromptImprovers(
  current: PromptImprover[],
  defaults: PromptImprover[],
): PromptImprover[] {
  const byId = new Map(defaults.map((d) => [d.id, d]));
  const present = new Set(current.map((t) => t.id));
  return [
    ...current.map((t) => byId.get(t.id) ?? t),
    ...defaults.filter((d) => !present.has(d.id)),
  ];
}

/** A named Log-tab query — `tt_config::SavedView`. `days` is how far back it
 * reads; `filters` is the chip bar's predicate list. */
export type SavedView = {
  id: string;
  label: string;
  filters: Filter[];
  days: number;
  query: string;
};

/** Permanent key, as {@link nextCalendarSourceId}. */
export function nextSavedViewId(views: SavedView[], label: string): string {
  const taken = new Set(views.map((v) => v.id));
  const base = slugify(label) || "view";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** One row of the Telemetry screen's Query tab — a name and its SQL. */
export type SavedQuery = {
  id: string;
  label: string;
  sql: string;
};

/** Permanent key, as {@link nextCalendarSourceId}. */
export function nextSavedQueryId(queries: SavedQuery[], label: string): string {
  const taken = new Set(queries.map((q) => q.id));
  const base = slugify(label) || "query";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A Rules-tab scorer — `tt_config::TelemetryRule`. `pass` is only read for a
 * `share` rule; `threshold` is a percentage for `share`, a count for `count`. */
export type TelemetryRule = {
  id: string;
  label: string;
  enabled: boolean;
  kind: RuleKind;
  select: Filter[];
  pass: Filter[];
  threshold: number;
  days: number;
};

/** Permanent key, as {@link nextCalendarSourceId}. */
export function nextTelemetryRuleId(rules: TelemetryRule[], label: string): string {
  const taken = new Set(rules.map((r) => r.id));
  const base = slugify(label) || "rule";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Read from `tt_config`, like {@link defaultPromptImprovers}. */
export function defaultSavedQueries() {
  return runIpc(
    invoke<SavedQuery[]>("settings_default_saved_queries", {}, { schema: SavedQueryListSchema }),
  );
}

/** Appends the built-in queries the user doesn't have by id; one they kept is
 * left as edited, since a query is theirs once saved. */
export function withMissingSavedQueries(
  current: SavedQuery[],
  defaults: SavedQuery[],
): SavedQuery[] {
  const have = new Set(current.map((q) => q.id));
  return [...current, ...defaults.filter((q) => !have.has(q.id))];
}

/** Read from `tt_config`, like {@link defaultPromptImprovers}. */
export function defaultTelemetryRules() {
  return runIpc(
    invoke<TelemetryRule[]>(
      "settings_default_telemetry_rules",
      {},
      { schema: TelemetryRuleListSchema },
    ),
  );
}

/** Restores the built-ins in place and appends missing ones; user-added rules
 * are untouched — the same rule as {@link withDefaultPromptImprovers}. */
export function withDefaultTelemetryRules(
  current: TelemetryRule[],
  defaults: TelemetryRule[],
): TelemetryRule[] {
  const byId = new Map(defaults.map((d) => [d.id, d]));
  const present = new Set(current.map((r) => r.id));
  return [
    ...current.map((r) => byId.get(r.id) ?? r),
    ...defaults.filter((d) => !present.has(d.id)),
  ];
}

type CalendarCollector = {
  enabled: boolean;
  refreshMinutes: number;
  quietHours: CalendarQuietHours;
  sources: CalendarSource[];
};

type PrCollector = {
  enabled: boolean;
  refreshSeconds: number;
  mergedRefreshMinutes: number;
};

type IssueCollector = {
  enabled: boolean;
  refreshMinutes: number;
  /** Open issues with any of these labels are offered on the Board as tasks to start. */
  watchedLabels: string[];
};

type SlackDmCollector = {
  enabled: boolean;
  token: string;
  /** Optional app-level token (xapp-…) enabling Socket Mode real-time delivery. */
  appToken: string;
  watchUserId: string;
  watchName: string;
  refreshSeconds: number;
};

type CollectorsSettings = {
  calendar: CalendarCollector;
  prs: PrCollector;
  issues: IssueCollector;
  slack: SlackDmCollector;
};

export type UserSettings = {
  preferredEditor: string;
  journalSettings: JournalSettings;
  promptImprovers: PromptImprover[];
  taskTemplates: TaskTemplate[];
  savedViews: SavedView[];
  savedQueries: SavedQuery[];
  telemetryRules: TelemetryRule[];
  collectors: CollectorsSettings;
  /** The tt Claude mod's `/next`: one bare model question per keystroke, capped per day.
   * Rust reads it (`tt_config::NextPromptSettings`); unset keys take its defaults. */
  nextPrompt?: { question?: string; model?: string; dailyBudgetUsd?: number };
  /** Rust reads it (`tt_config::TelemetrySettings`) when the app starts. */
  telemetry?: { retainDays?: number };
  /** Rust reads it (`tt_config::UpdatesSettings`); unset means the stable channel. */
  updates?: { channel?: UpdateChannel };
  /** `tt-clip`'s paste chords (`tt_config::ClipboardSettings`), e.g. "shift+Insert". */
  clipboard?: { pasteTextKeys?: string; pasteImageKeys?: string };
  /** TS-owned; every key is unset-means-default. `showUnmanagedWorktrees` is
   * the one Rust reads back, so it is written through
   * `ab_set_show_unmanaged_worktrees`, not by saving here. */
  agentboard?: {
    notify?: boolean;
    notifyThreshold?: NotifyLevel;
    compactRecommendPercent?: number;
    copyOnSelect?: boolean;
    terminalFontSize?: number;
    shortcutsWorkInTerminal?: boolean;
    autoResume?: boolean;
    advanceAfterSubmit?: boolean;
    shortcutCoach?: boolean;
    boardGroupByRepo?: boolean;
    autoCloseLanded?: boolean;
    railFilter?: RailFilter;
    railRecentHours?: number;
    /** Archive a repo idle this long; unset or 0 is off — off is written as 0,
     * since the merging save keeps a key that is merely absent. Rust reads it. */
    autoArchiveAfterHours?: number;
    railRepoSort?: RailSort;
    railTaskSort?: RailSort;
    showUnmanagedWorktrees?: boolean;
    browserPane?: boolean;
    /** macOS only — see `lib/keymap.ts`. */
    pcKeybindings?: boolean;
  } & Record<string, unknown>;
};

export type SaveState = "idle" | "saving" | "saved" | "error";

/** A half-finished path template must not reach the live scheduler. */
const DEFER_MS = 500;

/** `null` in browser dev or on a failed read; every consumer has a default. */
export async function loadUserSettings(): Promise<UserSettings | null> {
  const result = await runIpc(
    invoke<UserSettings>("settings_get", {}, { schema: UserSettingsSchema }),
  );
  return Result.getOrElse(result, () => null);
}

/** The full object, never a patch, so the TS CLI's unknown keys survive. */
async function saveUserSettings(settings: UserSettings): Promise<boolean> {
  const saved = await runIpc(invoke("settings_set", { settings }));
  return Result.isSuccess(saved);
}

export type AgentboardBlock = NonNullable<UserSettings["agentboard"]>;

export type SettingsUpdater = (prev: UserSettings) => UserSettings;

/** Two ordering rules, kept free of React so they are testable without a DOM.
 * **Replay, don't overwrite** — a queued edit is kept as its *updater* and
 * replayed against a fresh read. And **one write at a time**, chained on
 * `tail`, or the second flush reads before the first's write lands. */
export function createSettingsWriter({
  load,
  save,
  onState,
  deferMs = DEFER_MS,
}: {
  load: () => Promise<UserSettings | null>;
  save: (settings: UserSettings) => Promise<boolean>;
  onState: (state: SaveState) => void;
  deferMs?: number;
}) {
  let queued: SettingsUpdater[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tail: Promise<void> = Promise.resolve();

  const drain = async () => {
    const replay = queued;
    if (replay.length === 0) return;
    queued = [];
    onState("saving");
    const disk = await load();
    if (!disk) {
      onState("error");
      return;
    }
    onState((await save(replay.reduce((acc, fn) => fn(acc), disk))) ? "saved" : "error");
  };

  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const run = tail.then(drain);
    // Swallowed only to keep the chain alive; `onState` already reported it.
    tail = run.catch(() => {});
    return run;
  };

  return {
    /** Edits queued but not yet written: replayed over any fresh read. */
    pending: (): readonly SettingsUpdater[] => queued,
    queue(fn: SettingsUpdater, opts?: { defer?: boolean }) {
      queued.push(fn);
      if (!opts?.defer) {
        void flush();
        return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => void flush(), deferMs);
    },
    flush,
  };
}

/** The one copy of the settings file in the app. `settings` is `null` until
 * the first read lands (and stays `null` in browser dev); every reader has a
 * default. An edit applies here at once and is written in the background. */
export type SettingsValue = { settings: UserSettings | null; loaded: boolean };

const settingsState = Atom.make<SettingsValue>({ settings: null, loaded: false }).pipe(
  Atom.keepAlive,
);
export const userSettingsAtom: Atom.Atom<SettingsValue> = settingsState;

const saveStateValue = Atom.make<SaveState>("idle").pipe(Atom.keepAlive);
const saveStateAtom: Atom.Atom<SaveState> = saveStateValue;

const writer = createSettingsWriter({
  load: loadUserSettings,
  save: async (next) => {
    const ok = await saveUserSettings(next);
    if (ok) void reloadSettings();
    return ok;
  },
  onState: (state) => write(saveStateValue, state),
});

/** Read the file again — on window focus, after a save, after a write Rust
 * owns. Edits still queued replay over the read, so a reload never undoes one. */
export async function reloadSettings(): Promise<void> {
  const disk = await loadUserSettings();
  const settings = disk && writer.pending().reduce((acc, fn) => fn(acc), disk);
  write(settingsState, { settings, loaded: true });
}

/** "The file may have changed": the app opened, or the window took focus. **The
 * refresh policy lives here and only here.** */
feed("settings", () =>
  Effect.gen(function* () {
    yield* Effect.promise(reloadSettings);
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const onFocus = () => void reloadSettings();
        window.addEventListener("focus", onFocus);
        return onFocus;
      }),
      (onFocus) => Effect.sync(() => window.removeEventListener("focus", onFocus)),
    );
  }),
);

/** Apply `fn` to the held settings now; nothing is written. For a key whose
 * write Rust owns (an IPC command), followed by that command. */
export function patchSettingsLocal(fn: SettingsUpdater): void {
  const cur = read(settingsState);
  if (cur.settings) write(settingsState, { ...cur, settings: fn(cur.settings) });
}

/** Persist an edit: it applies to every reader at once, then replays against a
 * fresh read of the file. Pass `{ defer: true }` for anything typed and
 * {@link flushSettings} on blur. A no-op until the file has been read. */
export function updateSettings(fn: SettingsUpdater, opts?: { defer?: boolean }): void {
  if (read(settingsState).settings === null) return;
  patchSettingsLocal(fn);
  writer.queue(fn, opts);
}

const flushSettings = (): Promise<void> => writer.flush();

export function persistAgentboardSetting<K extends keyof AgentboardBlock>(
  key: K,
  value: AgentboardBlock[K],
): void {
  updateSettings((s) => ({ ...s, agentboard: { ...s.agentboard, [key]: value } }));
}

const pick = <T>(v: SettingsValue, select: (s: UserSettings) => T | undefined, fallback: T): T =>
  v.settings ? (select(v.settings) ?? fallback) : fallback;

/** One setting, live. `select` must not build a new object or array per call. */
export const useSetting = <T>(select: (s: UserSettings) => T | undefined, fallback: T): T =>
  useAtomValue(settingsState, (v) => pick(v, select, fallback));

/** One setting as of now, for a handler that reads it where it acts. */
export const readSetting = <T>(select: (s: UserSettings) => T | undefined, fallback: T): T =>
  pick(read(settingsState), select, fallback);

/** Unset means on; each is read where it acts and where Settings shows it. */
export const DEFAULT_AUTO_RESUME = true;
export const DEFAULT_ADVANCE_AFTER_SUBMIT = true;

/** The settings file for an editor of it (Settings, saved queries): the held
 * copy, whether it has been read, the save state, and the two writers. */
export function useUserSettings() {
  const { settings, loaded } = useAtomValue(settingsState);
  const saveState = useAtomValue(saveStateAtom);
  return { settings, loaded, saveState, update: updateSettings, flush: flushSettings };
}

/** One setting as an atom, for a derived atom that depends on it. */
export const settingAtom = <T>(
  select: (s: UserSettings) => T | undefined,
  fallback: T,
): Atom.Atom<T> => Atom.make((get) => pick(get(settingsState), select, fallback));
