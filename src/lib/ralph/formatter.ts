import { execFileSync } from "node:child_process";
import type { RalphTask, TaskStatus, RalphState } from "./state.js";

// ============================================================================
// Clipboard Utility
// ============================================================================

export function copyToClipboard(text: string): boolean {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      execFileSync("pbcopy", [], { input: text });
    } else if (platform === "linux") {
      // Try xclip first, then xsel
      try {
        execFileSync("xclip", ["-selection", "clipboard"], { input: text });
      } catch {
        execFileSync("xsel", ["--clipboard", "--input"], { input: text });
      }
    } else if (platform === "win32") {
      execFileSync("clip", [], { input: text });
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Task Formatting
// ============================================================================

export function formatTasksForPrompt(tasks: RalphTask[]): string {
  if (tasks.length === 0) {
    return "No tasks.";
  }

  const statusIcon = (status: TaskStatus): string => {
    switch (status) {
      case "done":
        return "✓";
      case "ready":
        return "○";
      case "blocked":
        return "⏸";
      case "cancelled":
        return "✗";
    }
  };

  const lines: string[] = [];
  for (const t of tasks) {
    const checkbox = t.status === "done" ? "[x]" : "[ ]";
    lines.push(`- ${checkbox} #${t.id} ${t.description} \`${statusIcon(t.status)} ${t.status}\``);
  }

  return lines.join("\n");
}

/**
 * Format tasks as markdown with checkboxes and status badges.
 */
export function formatTasksAsMarkdown(tasks: RalphTask[]): string {
  if (tasks.length === 0) {
    return "# Tasks\n\nNo tasks.\n";
  }

  const statusBadge = (status: TaskStatus): string => {
    switch (status) {
      case "done":
        return "`✓ done`";
      case "ready":
        return "`○ ready`";
      case "blocked":
        return "`⏸ blocked`";
      case "cancelled":
        return "`✗ cancelled`";
    }
  };

  const ready = tasks.filter((t) => t.status === "ready");
  const done = tasks.filter((t) => t.status === "done");

  const lines: string[] = ["# Tasks", ""];
  lines.push(
    `**Total:** ${tasks.length} | **Done:** ${done.length} | **Ready:** ${ready.length}`,
    "",
  );

  if (ready.length > 0) {
    lines.push("## Ready", "");
    for (const t of ready) {
      lines.push(`- [ ] **#${t.id}** ${t.description} ${statusBadge(t.status)}`);
    }
    lines.push("");
  }

  if (done.length > 0) {
    lines.push("## Done", "");
    for (const t of done) {
      lines.push(`- [x] **#${t.id}** ${t.description} ${statusBadge(t.status)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format tasks as a plan with markdown and optional mermaid graph.
 */
export function formatPlanAsMarkdown(tasks: RalphTask[], state: RalphState): string {
  const lines: string[] = ["# Ralph Plan", ""];

  // Summary section
  const ready = tasks.filter((t) => t.status === "ready").length;
  const done = tasks.filter((t) => t.status === "done").length;

  lines.push("## Summary", "");
  lines.push(`- **Status:** ${state.status}`);
  lines.push(`- **Iteration:** ${state.iteration}/${state.maxIterations}`);
  lines.push(`- **Total Tasks:** ${tasks.length}`);
  lines.push(`- **Done:** ${done} | **Ready:** ${ready}`);
  lines.push("");

  // Tasks section with checkboxes
  lines.push("## Tasks", "");
  for (const t of tasks) {
    const checkbox = t.status === "done" ? "[x]" : "[ ]";
    const status = t.status === "done" ? "`done`" : "`ready`";
    lines.push(`- ${checkbox} **#${t.id}** ${t.description} ${status}`);
  }
  lines.push("");

  // Mermaid graph section
  lines.push("## Progress Graph", "");
  lines.push("```mermaid");
  lines.push("graph LR");
  lines.push(`    subgraph Progress["Tasks: ${done}/${tasks.length} done"]`);

  for (const t of tasks) {
    const shortDesc =
      t.description.length > 30 ? t.description.slice(0, 27) + "..." : t.description;
    // Escape quotes in descriptions
    const safeDesc = shortDesc.replace(/"/g, "'");
    const nodeId = `T${t.id}`;

    if (t.status === "done") {
      lines.push(`        ${nodeId}["#${t.id}: ${safeDesc}"]:::done`);
    } else {
      lines.push(`        ${nodeId}["#${t.id}: ${safeDesc}"]:::ready`);
    }
  }

  lines.push("    end");
  lines.push("    classDef done fill:#22c55e,color:#fff");
  lines.push("    classDef ready fill:#94a3b8,color:#000");
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

/**
 * Format tasks as JSON for programmatic consumption.
 */
export function formatPlanAsJson(tasks: RalphTask[], state: RalphState): string {
  return JSON.stringify(
    {
      status: state.status,
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      summary: {
        total: tasks.length,
        done: tasks.filter((t) => t.status === "done").length,
        ready: tasks.filter((t) => t.status === "ready").length,
      },
      tasks: tasks.map((t) => ({
        id: t.id,
        description: t.description,
        status: t.status,
        addedAt: t.addedAt,
        completedAt: t.completedAt,
      })),
    },
    null,
    2,
  );
}

// ============================================================================
// Duration Formatting
// ============================================================================

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMins = minutes % 60;
    return `${hours}h ${remainingMins}m`;
  }
  if (minutes > 0) {
    const remainingSecs = seconds % 60;
    return `${minutes}m ${remainingSecs}s`;
  }
  return `${seconds}s`;
}

// ============================================================================
// Output Summary
// ============================================================================

export function extractOutputSummary(output: string, maxLength: number = 2000): string {
  const lines = output
    .split("\n")
    .filter((l) => l.trim())
    .slice(-5);
  let summary = lines.join(" ").trim();

  if (summary.length > maxLength) {
    summary = summary.substring(0, maxLength) + "...";
  }

  return summary || "(no output)";
}

// ============================================================================
// Prompt Building
// ============================================================================

export interface BuildPromptOptions {
  completionMarker: string;
  focusedTaskId: number | null;
  skipCommit?: boolean;
  taskList: string;
}

export function buildIterationPrompt({
  completionMarker,
  focusedTaskId,
  skipCommit = false,
  taskList,
}: BuildPromptOptions): string {
  // prompt inspired by https://www.aihero.dev/tips-for-ai-coding-with-ralph-wiggum#2-start-with-hitl-then-go-afk

  let step = 1;

  const prompt = `
<input-current-tasks>
${taskList}
</input-current-tasks>

<instructions>
${step++}. ${
    focusedTaskId
      ? `**Work on Task #${focusedTaskId}** (you've been asked to focus on this one).`
      : `**Choose** which ready task to work on next based on YOUR judgment of priority/dependencies.`
  }
${step++}. Work on that single task.
${step++}. Run type checks and tests.
${step++}. Mark the task done using CLI: \`tt ralph plan done <id>\`
${skipCommit ? "" : `${step++}. Make a git commit.`}

**ONE TASK PER ITERATION**

**Before ending:** Run \`tt ralph plan list\` to check remaining tasks.
**ONLY if ALL TASKS are done** then Output: <promise>${completionMarker}</promise>
</instructions>
`;
  return prompt.trim();
}

// ============================================================================
// Marker Detection
// ============================================================================

export function detectCompletionMarker(output: string, marker: string): boolean {
  return output.includes(marker);
}
