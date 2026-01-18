import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { RalphPlan, PlanStatus, RalphState } from "./state.js";

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

/**
 * Format plans as markdown with checkboxes and status badges.
 */
export function formatPlansAsMarkdown(plans: RalphPlan[]): string {
  if (plans.length === 0) {
    return "# Plans\n\nNo plans.\n";
  }

  const statusBadge = (status: PlanStatus): string => {
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

  const ready = plans.filter((p) => p.status === "ready");
  const done = plans.filter((p) => p.status === "done");

  const lines: string[] = ["# Plans", ""];
  lines.push(
    `**Total:** ${plans.length} | **Done:** ${done.length} | **Ready:** ${ready.length}`,
    "",
  );

  if (ready.length > 0) {
    lines.push("## Ready", "");
    for (const p of ready) {
      const errorSuffix = p.error ? ` ⚠️ ${p.error}` : "";
      lines.push(`- [ ] **#${p.id}** ${p.planFilePath} ${statusBadge(p.status)}${errorSuffix}`);
    }
    lines.push("");
  }

  if (done.length > 0) {
    lines.push("## Done", "");
    for (const p of done) {
      lines.push(`- [x] **#${p.id}** ${p.planFilePath} ${statusBadge(p.status)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format plans with markdown and optional mermaid graph.
 */
export function formatPlanAsMarkdown(plans: RalphPlan[], state: RalphState): string {
  const lines: string[] = ["# Ralph Plan", ""];

  // Summary section
  const ready = plans.filter((p) => p.status === "ready").length;
  const done = plans.filter((p) => p.status === "done").length;

  lines.push("## Summary", "");
  lines.push(`- **Status:** ${state.status}`);
  lines.push(`- **Total:** ${plans.length}`);
  lines.push(`- **Done:** ${done} | **Ready:** ${ready}`);
  lines.push("");

  // Plans section with checkboxes
  lines.push("## Plans", "");
  for (const p of plans) {
    const checkbox = p.status === "done" ? "[x]" : "[ ]";
    const status = p.status === "done" ? "`done`" : "`ready`";
    const errorSuffix = p.error ? ` ⚠️ ${p.error}` : "";
    lines.push(`- ${checkbox} **#${p.id}** ${p.planFilePath} ${status}${errorSuffix}`);
  }
  lines.push("");

  // Mermaid graph section
  lines.push("## Progress Graph", "");
  lines.push("```mermaid");
  lines.push("graph LR");
  lines.push(`    subgraph Progress["Plans: ${done}/${plans.length} done"]`);

  for (const p of plans) {
    const filename = path.basename(p.planFilePath);
    const shortName = filename.length > 30 ? filename.slice(0, 27) + "..." : filename;
    // Escape quotes in filenames
    const safeName = shortName.replace(/"/g, "'");
    const nodeId = `P${p.id}`;

    if (p.status === "done") {
      lines.push(`        ${nodeId}["#${p.id}: ${safeName}"]:::done`);
    } else {
      lines.push(`        ${nodeId}["#${p.id}: ${safeName}"]:::ready`);
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
 * Format plans as JSON for programmatic consumption.
 */
export function formatPlanAsJson(plans: RalphPlan[], state: RalphState): string {
  return JSON.stringify(
    {
      status: state.status,
      summary: {
        total: plans.length,
        done: plans.filter((p) => p.status === "done").length,
        ready: plans.filter((p) => p.status === "ready").length,
      },
      plans: plans.map((p) => ({
        id: p.id,
        planFilePath: p.planFilePath,
        status: p.status,
        addedAt: p.addedAt,
        completedAt: p.completedAt,
        error: p.error,
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
  plan: RalphPlan;
  planContent: string;
  skipCommit?: boolean;
}

export function buildIterationPrompt({
  completionMarker,
  plan,
  planContent,
  skipCommit = false,
}: BuildPromptOptions): string {
  let step = 1;

  const prompt = `
<plan>
${planContent}
</plan>

<instructions>
${step++}. Work on the plan above.
${step++}. Run type checks and tests.
${step++}. Mark done: \`tt ralph plan done ${plan.id}\`
${skipCommit ? "" : `${step++}. Make a git commit.`}

**Before ending:** Run \`tt ralph plan list\` to check remaining plans.
**ONLY if ALL PLANS are done** then Output: <promise>${completionMarker}</promise>
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
