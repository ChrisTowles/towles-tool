import * as fs from "node:fs";
import * as path from "node:path";
import pc from "picocolors";
import { z } from "zod";
import type { RalphSettings } from "../../config/settings.js";
import { RalphSettingsSchema } from "../../config/settings.js";

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_MAX_ITERATIONS = 10;
export const DEFAULT_STATE_DIR = "./.claude/.ralph";
export const DEFAULT_COMPLETION_MARKER = "RALPH_DONE";

// File names within stateDir
const STATE_FILE_NAME = "ralph-state.local.json";
const LOG_FILE_NAME = "ralph-log.local.md";
const HISTORY_FILE_NAME = "ralph-history.local.log";

// ============================================================================
// Path Helpers (use stateDir from settings)
// ============================================================================

export function getRalphPaths(settings?: RalphSettings) {
  const stateDir = settings?.stateDir ?? RalphSettingsSchema.parse({}).stateDir;
  return {
    stateFile: path.join(stateDir, STATE_FILE_NAME),
    logFile: path.join(stateDir, LOG_FILE_NAME),
    historyFile: path.join(stateDir, HISTORY_FILE_NAME),
  };
}

// Defaults used in flag descriptions
export const DEFAULT_STATE_FILE = `${DEFAULT_STATE_DIR}/${STATE_FILE_NAME}`;
export const DEFAULT_LOG_FILE = `${DEFAULT_STATE_DIR}/${LOG_FILE_NAME}`;
export const DEFAULT_HISTORY_FILE = `${DEFAULT_STATE_DIR}/${HISTORY_FILE_NAME}`;

/**
 * Resolve ralph file path - uses flag value if provided, otherwise computes from settings
 */
export function resolveRalphPath(
  flagValue: string | undefined,
  pathType: "stateFile" | "logFile" | "historyFile",
  settings?: RalphSettings,
): string {
  if (flagValue !== undefined) {
    return flagValue;
  }
  const paths = getRalphPaths(settings);
  return paths[pathType];
}
export const CLAUDE_DEFAULT_ARGS = [
  "--print",
  "--verbose",
  "--output-format",
  "stream-json",
  "--permission-mode",
  "bypassPermissions",
];

// ============================================================================
// State Validation Schemas
// ============================================================================

const PlanStatusSchema = z.enum(["ready", "done", "blocked", "cancelled"]);

const RalphPlanSchema = z.object({
  id: z.number(),
  description: z.string(),
  status: PlanStatusSchema,
  addedAt: z.string(),
  completedAt: z.string().optional(),
});

const RalphStateSchema = z.object({
  version: z.number(),
  plans: z.array(RalphPlanSchema),
  startedAt: z.string(),
  status: z.enum(["running", "completed", "max_iterations_reached", "error"]),
});

// ============================================================================
// Types (derived from Zod schemas)
// ============================================================================

export interface IterationHistory {
  iteration: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  durationHuman: string;
  outputSummary: string;
  markerFound: boolean;
  contextUsedPercent?: number;
}

export type PlanStatus = z.infer<typeof PlanStatusSchema>;
export type RalphPlan = z.infer<typeof RalphPlanSchema>;
export type RalphState = z.infer<typeof RalphStateSchema>;

// ============================================================================
// State Management
// ============================================================================

export function createInitialState(): RalphState {
  return {
    version: 1,
    plans: [],
    startedAt: new Date().toISOString(),
    status: "running",
  };
}

/**
 * Append iteration history as a JSON line to the history log file.
 * Each line is a complete JSON object for easy parsing.
 */
export function appendHistory(
  history: IterationHistory,
  historyFile: string = DEFAULT_HISTORY_FILE,
): void {
  fs.mkdirSync(path.dirname(historyFile), { recursive: true });
  const line = JSON.stringify(history) + "\n";
  fs.appendFileSync(historyFile, line);
}

export function saveState(state: RalphState, stateFile: string): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

export function loadState(stateFile: string): RalphState | null {
  try {
    if (!fs.existsSync(stateFile)) {
      return null;
    }
    const content = fs.readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(content);

    const result = RalphStateSchema.safeParse(parsed);
    if (!result.success) {
      const errors = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
      console.warn(pc.yellow(`Warning: Invalid state file ${stateFile}: ${errors}`));
      return null;
    }
    return result.data;
  } catch (err) {
    console.warn(pc.yellow(`Warning: Failed to load state file ${stateFile}: ${err}`));
    return null;
  }
}

export function addPlanToState(state: RalphState, description: string): RalphPlan {
  const nextId = state.plans.length > 0 ? Math.max(...state.plans.map((p) => p.id)) + 1 : 1;

  const newPlan: RalphPlan = {
    id: nextId,
    description,
    status: "ready",
    addedAt: new Date().toISOString(),
  };

  state.plans.push(newPlan);
  return newPlan;
}
