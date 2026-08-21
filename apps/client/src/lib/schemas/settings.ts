import { z } from "zod";

/**
 * `.passthrough()` everywhere matches the Rust side, so an unknown key in the
 * hand-edited settings file survives a read instead of being dropped on save.
 */

const JournalSettingsSchema = z
  .object({
    baseFolder: z.string(),
    dailyPathTemplate: z.string(),
    meetingPathTemplate: z.string(),
    notePathTemplate: z.string(),
    templateDir: z.string(),
  })
  .passthrough();

const CalendarQuietHoursSchema = z
  .object({
    enabled: z.boolean(),
    startHour: z.number(),
    endHour: z.number(),
    weekdays: z.array(z.number()),
  })
  .passthrough();

const CalendarSourceSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    enabled: z.boolean(),
    prompt: z.string(),
  })
  .passthrough();

const PromptImproverSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    enabled: z.boolean(),
    preferred: z.boolean(),
    prompt: z.string(),
  })
  .passthrough();

/** `settings_default_prompt_improvers` answers with a bare array. */
export const PromptImproverListSchema = z.array(PromptImproverSchema);

const CalendarCollectorSchema = z
  .object({
    enabled: z.boolean(),
    refreshMinutes: z.number(),
    quietHours: CalendarQuietHoursSchema,
    sources: z.array(CalendarSourceSchema),
  })
  .passthrough();

const PrCollectorSchema = z
  .object({
    enabled: z.boolean(),
    refreshSeconds: z.number(),
    mergedRefreshMinutes: z.number(),
  })
  .passthrough();

const IssueCollectorSchema = z
  .object({
    enabled: z.boolean(),
    refreshMinutes: z.number(),
  })
  .passthrough();

const SlackDmCollectorSchema = z
  .object({
    enabled: z.boolean(),
    token: z.string(),
    appToken: z.string(),
    watchUserId: z.string(),
    watchName: z.string(),
    refreshSeconds: z.number(),
  })
  .passthrough();

const CollectorsSettingsSchema = z
  .object({
    calendar: CalendarCollectorSchema,
    prs: PrCollectorSchema,
    issues: IssueCollectorSchema,
    slack: SlackDmCollectorSchema,
  })
  .passthrough();

/** Urgency levels, least → most urgent — mirrors Rust's `tt_config::NotifyLevel`. */
export const NotifyLevelSchema = z.enum(["routine", "important", "urgent"]);

/** Which checkouts reach the Agentboard rail — mirrors Rust's
 * `tt_config::RailFilter`. Not a scale: `active` asks about *now*, `recent`
 * asks about the last N hours. */
export const RailFilterSchema = z.enum(["all", "active", "recent"]);

/** `UserSettings["agentboard"]` is a TS-owned, partly-typed block that already
 * carries a `Record<string, unknown>` passthrough in its TS type — `.catchall`
 * keeps every key not listed here rather than requiring an exhaustive list. */
const AgentboardBlockSchema = z
  .object({
    notify: z.boolean().optional(),
    // `.catch` mirrors the Rust reader's tolerance: an unrecognized level (a
    // newer build's, a hand-edit) reads as unset — the default — instead of
    // failing the whole settings parse.
    notifyThreshold: NotifyLevelSchema.optional().catch(undefined),
    compactRecommendPercent: z.number().optional(),
    copyOnSelect: z.boolean().optional(),
    terminalFontSize: z.number().optional(),
    shortcutsWorkInTerminal: z.boolean().optional(),
    shortcutCoach: z.boolean().optional(),
    boardGroupByRepo: z.boolean().optional(),
    // `.catch` for the same reason as `notifyThreshold`: an unrecognized mode
    // (a newer build's, a hand-edit, the boolean this key used to be) reads as
    // unset rather than failing the whole settings parse.
    railFilter: RailFilterSchema.optional().catch(undefined),
    railRecentHours: z.number().optional(),
    showQuiet: z.boolean().optional(),
    showUnmanagedWorktrees: z.boolean().optional(),
    jarvisPane: z.boolean().optional(),
    browserPane: z.boolean().optional(),
  })
  .catchall(z.unknown());

export const UserSettingsSchema = z
  .object({
    preferredEditor: z.string(),
    journalSettings: JournalSettingsSchema,
    promptImprovers: z.array(PromptImproverSchema),
    collectors: CollectorsSettingsSchema,
    agentboard: AgentboardBlockSchema.optional(),
  })
  .passthrough();
