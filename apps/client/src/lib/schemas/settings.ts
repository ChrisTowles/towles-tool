import { Effect, Option, Schema } from "effect";
import { list, open } from "@/lib/schemas/shape";

/**
 * `open(...)` everywhere matches the Rust side, so an unknown key in the
 * hand-edited settings file survives a read instead of being dropped on save.
 */

const JournalSettingsSchema = open({
  baseFolder: Schema.String,
  dailyPathTemplate: Schema.String,
  meetingPathTemplate: Schema.String,
  notePathTemplate: Schema.String,
  templateDir: Schema.String,
});

const CalendarQuietHoursSchema = open({
  enabled: Schema.Boolean,
  startHour: Schema.Number,
  endHour: Schema.Number,
  weekdays: list(Schema.Number),
});

const CalendarSourceSchema = open({
  id: Schema.String,
  label: Schema.String,
  enabled: Schema.Boolean,
  prompt: Schema.String,
});

const PromptImproverSchema = open({
  id: Schema.String,
  label: Schema.String,
  enabled: Schema.Boolean,
  preferred: Schema.Boolean,
  prompt: Schema.String,
});

const TelemetryFilterSchema = open({
  field: Schema.String,
  op: Schema.Literals(["eq", "neq", "contains", "gt", "lt"]),
  value: Schema.String,
});

const SavedViewSchema = open({
  id: Schema.String,
  label: Schema.String,
  filters: list(TelemetryFilterSchema),
  days: Schema.Number,
  query: Schema.String,
});

const TelemetryRuleSchema = open({
  id: Schema.String,
  label: Schema.String,
  enabled: Schema.Boolean,
  kind: Schema.Literals(["share", "count"]),
  select: list(TelemetryFilterSchema),
  pass: list(TelemetryFilterSchema),
  threshold: Schema.Number,
  days: Schema.Number,
});

/** `settings_default_prompt_improvers` answers with a bare array. */
export const PromptImproverListSchema = list(PromptImproverSchema);

const TaskTemplateSchema = open({
  id: Schema.String,
  label: Schema.String,
  repo: Schema.String,
  goal: Schema.String,
  improver: Schema.String,
  setup: Schema.String,
});

export const TaskTemplateListSchema = list(TaskTemplateSchema);

const SavedQuerySchema = open({
  id: Schema.String,
  label: Schema.String,
  sql: Schema.String,
});
/** `settings_default_saved_queries` returns this. */
export const SavedQueryListSchema = list(SavedQuerySchema);
/** So does `settings_default_telemetry_rules`. */
export const TelemetryRuleListSchema = list(TelemetryRuleSchema);

const CalendarCollectorSchema = open({
  enabled: Schema.Boolean,
  refreshMinutes: Schema.Number,
  quietHours: CalendarQuietHoursSchema,
  sources: list(CalendarSourceSchema),
});

const PrCollectorSchema = open({
  enabled: Schema.Boolean,
  refreshSeconds: Schema.Number,
  mergedRefreshMinutes: Schema.Number,
});

const IssueCollectorSchema = open({
  enabled: Schema.Boolean,
  refreshMinutes: Schema.Number,
  watchedLabels: list(Schema.String),
});

const SlackDmCollectorSchema = open({
  enabled: Schema.Boolean,
  token: Schema.String,
  appToken: Schema.String,
  watchUserId: Schema.String,
  watchName: Schema.String,
  refreshSeconds: Schema.Number,
});

const CollectorsSettingsSchema = open({
  calendar: CalendarCollectorSchema,
  prs: PrCollectorSchema,
  issues: IssueCollectorSchema,
  slack: SlackDmCollectorSchema,
});

/** Urgency levels, least → most urgent — mirrors Rust's `tt_config::NotifyLevel`. */
const NotifyLevelSchema = Schema.Literals(["routine", "important", "urgent"]);

/** Which checkouts reach the Agentboard rail — mirrors Rust's
 * `tt_config::RailFilter`. Not a scale: `active` asks about *now*, `recent`
 * asks about the last N hours. */
const RailFilterSchema = Schema.Literals(["all", "active", "recent"]);

/** Mirrors Rust's `tt_config::RailSort`. */
const RailSortSchema = Schema.Literals(["manual", "name", "recent"]);

/** An optional key whose unrecognized value reads as unset, mirroring the Rust
 * reader's tolerance: a newer build's level or a hand-edit must not fail the
 * whole settings parse. */
const lenient = <S extends Schema.Top>(schema: S) =>
  Schema.optional(schema).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))));

/** `UserSettings["agentboard"]` is a TS-owned, partly-typed block that already
 * carries a `Record<string, unknown>` passthrough in its TS type — `open` keeps
 * every key not listed here rather than requiring an exhaustive list. */
const AgentboardBlockSchema = open({
  notify: Schema.optional(Schema.Boolean),
  notifyThreshold: lenient(NotifyLevelSchema),
  compactRecommendPercent: Schema.optional(Schema.Number),
  copyOnSelect: Schema.optional(Schema.Boolean),
  terminalFontSize: Schema.optional(Schema.Number),
  shortcutsWorkInTerminal: Schema.optional(Schema.Boolean),
  autoResume: Schema.optional(Schema.Boolean),
  advanceAfterSubmit: Schema.optional(Schema.Boolean),
  shortcutCoach: Schema.optional(Schema.Boolean),
  boardGroupByRepo: Schema.optional(Schema.Boolean),
  autoCloseLanded: Schema.optional(Schema.Boolean),
  railFilter: lenient(RailFilterSchema),
  railRecentHours: Schema.optional(Schema.Number),
  autoArchiveAfterHours: Schema.optional(Schema.Number),
  railRepoSort: lenient(RailSortSchema),
  railTaskSort: lenient(RailSortSchema),
  showQuiet: Schema.optional(Schema.Boolean),
  showUnmanagedWorktrees: Schema.optional(Schema.Boolean),
  browserPane: Schema.optional(Schema.Boolean),
  pcKeybindings: Schema.optional(Schema.Boolean),
});

export const UserSettingsSchema = open({
  preferredEditor: Schema.String,
  journalSettings: JournalSettingsSchema,
  promptImprovers: list(PromptImproverSchema),
  taskTemplates: TaskTemplateListSchema.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  savedViews: list(SavedViewSchema),
  savedQueries: list(SavedQuerySchema),
  telemetryRules: list(TelemetryRuleSchema),
  collectors: CollectorsSettingsSchema,
  agentboard: Schema.optional(AgentboardBlockSchema),
});
