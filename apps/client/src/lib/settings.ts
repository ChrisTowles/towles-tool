import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  PromptImproverListSchema,
  TelemetryRuleListSchema,
  UserSettingsSchema,
} from "./schemas/settings";
import { invoke } from "./tauri";
import { slugify } from "./slug";
import type { Filter, RuleKind } from "./telemetry";

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

export type JournalSettings = {
  baseFolder: string;
  dailyPathTemplate: string;
  meetingPathTemplate: string;
  notePathTemplate: string;
  templateDir: string;
};

/** Weekdays: 0 = Monday … 6 = Sunday. */
export type CalendarQuietHours = {
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

/** Read from `tt_config` — a second copy of prompts this long drifts. */
export function defaultPromptImprovers() {
  return invoke<PromptImprover[]>(
    "settings_default_prompt_improvers",
    {},
    { schema: PromptImproverListSchema },
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
export function defaultTelemetryRules() {
  return invoke<TelemetryRule[]>(
    "settings_default_telemetry_rules",
    {},
    { schema: TelemetryRuleListSchema },
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

export type CalendarCollector = {
  enabled: boolean;
  refreshMinutes: number;
  quietHours: CalendarQuietHours;
  sources: CalendarSource[];
};

export type PrCollector = {
  enabled: boolean;
  refreshSeconds: number;
  mergedRefreshMinutes: number;
};

export type IssueCollector = {
  enabled: boolean;
  refreshMinutes: number;
};

export type SlackDmCollector = {
  enabled: boolean;
  token: string;
  /** Optional app-level token (xapp-…) enabling Socket Mode real-time delivery. */
  appToken: string;
  watchUserId: string;
  watchName: string;
  refreshSeconds: number;
};

export type CollectorsSettings = {
  calendar: CalendarCollector;
  prs: PrCollector;
  issues: IssueCollector;
  slack: SlackDmCollector;
};

export type UserSettings = {
  preferredEditor: string;
  journalSettings: JournalSettings;
  promptImprovers: PromptImprover[];
  savedViews: SavedView[];
  telemetryRules: TelemetryRule[];
  collectors: CollectorsSettings;
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
    shortcutCoach?: boolean;
    boardGroupByRepo?: boolean;
    railFilter?: RailFilter;
    railRecentHours?: number;
    showQuiet?: boolean;
    showUnmanagedWorktrees?: boolean;
    jarvisPane?: boolean;
    browserPane?: boolean;
  } & Record<string, unknown>;
};

export type SaveState = "idle" | "saving" | "saved" | "error";

/** A half-finished path template must not reach the live scheduler. */
const DEFER_MS = 500;

/** Settings is a tab in the same window, so `"focus"` never fires. */
export const SETTINGS_SAVED_EVENT = "tt:settings-saved";

/** `null` in browser dev or on a failed read; every consumer has a default. */
export async function loadUserSettings(): Promise<UserSettings | null> {
  const result = await invoke<UserSettings>("settings_get", {}, { schema: UserSettingsSchema });
  return result.unwrapOr(null);
}

/** The full object, never a patch, so the TS CLI's unknown keys survive. */
export async function saveUserSettings(settings: UserSettings): Promise<boolean> {
  const saved = await invoke("settings_set", { settings });
  if (saved.isOk()) window.dispatchEvent(new Event(SETTINGS_SAVED_EVENT));
  return saved.isOk();
}

export type AgentboardBlock = NonNullable<UserSettings["agentboard"]>;

/** "The file may have changed": an in-app save, or window focus. Fires `load`
 * once immediately. **The refresh policy lives here and only here.** */
export function onSettingsChanged(load: () => void): () => void {
  load();
  window.addEventListener("focus", load);
  window.addEventListener(SETTINGS_SAVED_EVENT, load);
  return () => {
    window.removeEventListener("focus", load);
    window.removeEventListener(SETTINGS_SAVED_EVENT, load);
  };
}

/** One value, live across {@link onSettingsChanged} signals. The setter is
 * **local** — write-through is the caller's job. */
export function useLiveSetting<T>(
  select: (s: UserSettings) => T | undefined,
  fallback: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState(fallback);
  const selectRef = useRef(select);
  selectRef.current = select;
  useEffect(() => {
    let alive = true;
    const unsubscribe = onSettingsChanged(() => {
      void loadUserSettings().then((s) => {
        // `alive` discards a read that resolved after unmount.
        if (alive && s) setValue(selectRef.current(s) ?? fallback);
      });
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [fallback]);
  return [value, setValue];
}

/** {@link useLiveSetting} into a ref, for an effect that must not re-subscribe. */
export function useLiveSettingRef<T>(
  select: (s: UserSettings) => T | undefined,
  fallback: T,
): RefObject<T> {
  const ref = useRef(fallback);
  const selectRef = useRef(select);
  selectRef.current = select;
  useEffect(() => {
    let alive = true;
    const unsubscribe = onSettingsChanged(() => {
      void loadUserSettings().then((s) => {
        if (alive && s) ref.current = selectRef.current(s) ?? fallback;
      });
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [fallback]);
  return ref;
}

/** The read is the point: a save must carry the whole object forward. */
export async function persistAgentboardSetting<K extends keyof AgentboardBlock>(
  key: K,
  value: AgentboardBlock[K],
): Promise<void> {
  const s = await loadUserSettings();
  if (!s) return;
  await saveUserSettings({ ...s, agentboard: { ...s.agentboard, [key]: value } });
}

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

/** Load once, persist every edit — there is no explicit save. Pass `{ defer:
 * true }` for anything typed and `flush` on blur. */
export function useUserSettings() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const live = useRef(false);
  const [writer] = useState(() =>
    createSettingsWriter({
      load: loadUserSettings,
      save: saveUserSettings,
      onState: setSaveState,
    }),
  );

  useEffect(() => {
    let alive = true;
    void loadUserSettings().then((s) => {
      if (!alive) return;
      live.current = s !== null;
      setSettings(s);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Commit a pending debounce on unmount, or an edit navigated away from is lost.
  useEffect(
    () => () => {
      void writer.flush();
    },
    [writer],
  );

  const update = useCallback(
    (fn: SettingsUpdater, opts?: { defer?: boolean }) => {
      if (!live.current) return;
      setSettings((prev) => (prev ? fn(prev) : prev));
      writer.queue(fn, opts);
    },
    [writer],
  );

  return { settings, loaded, saveState, update, flush: writer.flush };
}
