import {
  aggregateSessionTools,
  analyzeSession,
  extractProjectName,
  getModelName,
  getPrimaryModel,
} from "./analyzer.js";
import { extractSessionLabel } from "./labels.js";
import { parseJsonl } from "./parser.js";
import { extractToolData } from "./tools.js";
import type { JournalEntry, TreemapNode } from "./types.js";

/**
 * Build turn-level nodes from session entries.
 * Used by both single-session and all-sessions views.
 */
export function buildTurnNodes(
  sessionId: string,
  entries: JournalEntry[],
  filePath?: string,
): TreemapNode[] {
  const children: TreemapNode[] = [];
  let turnNumber = 0;

  for (const entry of entries) {
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (!entry.message) continue;

    const role = entry.message.role;
    const usage = entry.message.usage;
    const model = entry.message.model;

    if (role === "user") {
      turnNumber++;
    }

    if (!usage) continue;

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const totalTokens = inputTokens + outputTokens;

    if (totalTokens === 0) continue;

    const ratio = outputTokens > 0 ? inputTokens / outputTokens : inputTokens > 0 ? 999 : 0;

    // Extract individual tool calls from content blocks
    const tools = extractToolData(entry.message.content, inputTokens, outputTokens);

    // Create individual tool children nodes
    const toolChildren: TreemapNode[] = tools.map((tool) => ({
      name: tool.detail ? `${tool.name}: ${tool.detail}` : tool.name,
      value: tool.inputTokens + tool.outputTokens,
      inputTokens: tool.inputTokens,
      outputTokens: tool.outputTokens,
      ratio: tool.outputTokens > 0 ? tool.inputTokens / tool.outputTokens : 0,
      toolName: tool.name,
    }));

    // Format turn name based on tools used
    let turnName: string;
    let primaryToolName: string | undefined;
    if (role === "user") {
      turnName = `Turn ${turnNumber}: User`;
    } else if (tools.length === 1) {
      // Single tool: show tool name and detail
      const t = tools[0];
      turnName = t.detail ? `${t.name}: ${t.detail}` : t.name;
      primaryToolName = t.name;
    } else if (tools.length > 1) {
      // Multiple tools: list unique tool names, primary is most common
      const uniqueNames = [...new Set(tools.map((t) => t.name))];
      turnName = uniqueNames.slice(0, 3).join(", ") + (uniqueNames.length > 3 ? "..." : "");
      primaryToolName = tools[0].name; // Use first tool as primary
    } else {
      turnName = `Turn ${turnNumber}: Response`;
      primaryToolName = "Response";
    }
    children.push({
      name: turnName,
      value: toolChildren.length > 0 ? undefined : totalTokens, // Let children sum if present
      children: toolChildren.length > 0 ? toolChildren : undefined,
      sessionId: sessionId.slice(0, 8),
      fullSessionId: sessionId,
      filePath,
      toolName: primaryToolName,
      model: getModelName(model),
      inputTokens,
      outputTokens,
      ratio,
      tools: tools.length > 0 ? tools : undefined,
    });
  }

  return children;
}

/**
 * Build treemap for a single session.
 */
export function buildSessionTreemap(sessionId: string, entries: JournalEntry[]): TreemapNode {
  return {
    name: `Session ${sessionId.slice(0, 8)}`,
    children: buildTurnNodes(sessionId, entries),
  };
}

/**
 * Build treemap for all sessions, grouped by project and date.
 */
export function buildAllSessionsTreemap(
  sessions: Array<{
    sessionId: string;
    path: string;
    date: string;
    tokens: number;
    project: string;
  }>,
): TreemapNode {
  // Group sessions by project, then by date
  const byProject = new Map<string, typeof sessions>();
  for (const session of sessions) {
    const projectName = extractProjectName(session.project);
    if (!byProject.has(projectName)) {
      byProject.set(projectName, []);
    }
    byProject.get(projectName)!.push(session);
  }

  // Sort projects by total tokens
  const projectTotals = [...byProject.entries()].map(([name, sess]) => ({
    name,
    sessions: sess,
    total: sess.reduce((sum, s) => sum + s.tokens, 0),
  }));
  projectTotals.sort((a, b) => b.total - a.total);

  const projectChildren: TreemapNode[] = [];

  for (const { name: projectName, sessions: projectSessions } of projectTotals) {
    // Group by date within project
    const byDate = new Map<string, typeof sessions>();
    for (const session of projectSessions) {
      if (!byDate.has(session.date)) {
        byDate.set(session.date, []);
      }
      byDate.get(session.date)!.push(session);
    }

    // Sort dates (most recent first)
    const sortedDates = [...byDate.keys()].sort().reverse();

    const dateChildren: TreemapNode[] = [];

    for (const date of sortedDates) {
      const dateSessions = byDate.get(date)!;

      const sessionChildren: TreemapNode[] = [];

      for (const session of dateSessions) {
        const entries = parseJsonl(session.path);
        const analysis = analyzeSession(entries);
        const label = extractSessionLabel(entries, session.sessionId);
        const tools = aggregateSessionTools(entries);
        const startTime = entries[0]?.timestamp
          ? new Date(entries[0].timestamp).toLocaleTimeString()
          : undefined;

        // Build turn-level children for drill-down
        const turnChildren = buildTurnNodes(session.sessionId, entries, session.path);

        sessionChildren.push({
          name: label,
          // If we have turn children, let them sum; otherwise use session total
          value: turnChildren.length > 0 ? undefined : session.tokens,
          children: turnChildren.length > 0 ? turnChildren : undefined,
          sessionId: session.sessionId.slice(0, 8),
          fullSessionId: session.sessionId,
          filePath: session.path,
          startTime,
          model: getPrimaryModel(analysis),
          inputTokens: analysis.inputTokens,
          outputTokens: analysis.outputTokens,
          ratio: analysis.outputTokens > 0 ? analysis.inputTokens / analysis.outputTokens : 0,
          date: session.date,
          project: projectName,
          repeatedReads: analysis.repeatedReads,
          modelEfficiency: analysis.modelEfficiency,
          tools: tools.length > 0 ? tools : undefined,
        });
      }

      dateChildren.push({
        name: date,
        children: sessionChildren,
        date,
      });
    }

    projectChildren.push({
      name: projectName,
      children: dateChildren,
      project: projectName,
    });
  }

  return {
    name: "All Sessions",
    children: projectChildren,
  };
}
