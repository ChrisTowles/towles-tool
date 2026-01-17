import { Flags } from "@oclif/core";
import { DateTime } from "luxon";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { x } from "tinyexec";
import { BaseCommand } from "./base.js";

// Load HTML template from file (resolved relative to this module)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "graph-template.html");

// Types for parsing Claude Code session JSONL files
interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface JournalEntry {
  type: string;
  sessionId: string;
  timestamp: string;
  message?: {
    role: "user" | "assistant";
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    content?: ContentBlock[] | string;
  };
  uuid?: string;
}

interface ToolData {
  name: string;
  detail?: string;
  inputTokens: number;
  outputTokens: number;
}

// Bar chart types for stacked bar visualization - aggregated by project
export interface ProjectBar {
  project: string;
  totalTokens: number;
}

export interface BarChartDay {
  date: string; // YYYY-MM-DD format
  projects: ProjectBar[];
}

export interface BarChartData {
  days: BarChartDay[];
}

export interface SessionResult {
  sessionId: string;
  path: string;
  date: string;
  tokens: number;
  project: string;
  mtime: number;
}

/**
 * Calculate cutoff timestamp for days filtering.
 * Returns 0 if days <= 0 (no filtering).
 */
export function calculateCutoffMs(days: number): number {
  return days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
}

/**
 * Filter items by mtime against a days cutoff.
 * Returns all items if days <= 0.
 */
export function filterByDays<T extends { mtime: number }>(items: T[], days: number): T[] {
  const cutoff = calculateCutoffMs(days);
  if (cutoff === 0) return items;
  return items.filter((item) => item.mtime >= cutoff);
}

/**
 * Parse JSONL file into JournalEntry array.
 */
export function parseJsonl(filePath: string): JournalEntry[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const entries: JournalEntry[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      // Skip invalid lines
    }
  }

  return entries;
}

/**
 * Analyze session entries to get token breakdown by model.
 */
export function analyzeSession(entries: JournalEntry[]): {
  inputTokens: number;
  outputTokens: number;
  opusTokens: number;
  sonnetTokens: number;
  haikuTokens: number;
  cacheHitRate: number;
  repeatedReads: number;
  modelEfficiency: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let opusTokens = 0;
  let sonnetTokens = 0;
  let haikuTokens = 0;
  let cacheRead = 0;
  let totalInput = 0;
  const fileReadCounts = new Map<string, number>();

  for (const entry of entries) {
    // Count file reads for repeatedReads metric
    if (entry.message?.content && Array.isArray(entry.message.content)) {
      for (const block of entry.message.content) {
        if (block.type === "tool_use" && block.name === "Read" && block.input) {
          const filePath = (block.input as { file_path?: string }).file_path;
          if (filePath) {
            fileReadCounts.set(filePath, (fileReadCounts.get(filePath) || 0) + 1);
          }
        }
      }
    }

    if (!entry.message?.usage) continue;
    const usage = entry.message.usage;
    const model = entry.message.model || "";
    const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);

    inputTokens += usage.input_tokens || 0;
    outputTokens += usage.output_tokens || 0;
    cacheRead += usage.cache_read_input_tokens || 0;
    totalInput += usage.input_tokens || 0;

    if (model.includes("opus")) opusTokens += tokens;
    else if (model.includes("sonnet")) sonnetTokens += tokens;
    else if (model.includes("haiku")) haikuTokens += tokens;
  }

  // Count files read more than once
  let repeatedReads = 0;
  for (const count of fileReadCounts.values()) {
    if (count > 1) repeatedReads += count - 1;
  }

  const totalTokens = opusTokens + sonnetTokens + haikuTokens;

  return {
    inputTokens,
    outputTokens,
    opusTokens,
    sonnetTokens,
    haikuTokens,
    cacheHitRate: totalInput > 0 ? cacheRead / totalInput : 0,
    repeatedReads,
    modelEfficiency: totalTokens > 0 ? opusTokens / totalTokens : 0,
  };
}

/**
 * Extract a meaningful label from session entries.
 */
export function extractSessionLabel(entries: JournalEntry[], sessionId: string): string {
  let firstUserText: string | undefined;
  let firstAssistantText: string | undefined;
  let gitBranch: string | undefined;
  let slug: string | undefined;

  for (const entry of entries) {
    // Extract metadata from any entry
    if (!gitBranch && (entry as any).gitBranch) {
      gitBranch = (entry as any).gitBranch;
    }
    if (!slug && (entry as any).slug) {
      slug = (entry as any).slug;
    }

    if (!entry.message) continue;

    // Look for first user message with actual text (not UUID reference)
    if (!firstUserText && entry.type === "user" && entry.message.role === "user") {
      const content = entry.message.content;
      if (typeof content === "string") {
        // Check if it's a UUID (skip those) or actual text
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          content,
        );
        if (!isUuid && content.length > 0) {
          firstUserText = content;
        }
      } else if (Array.isArray(content)) {
        // Look for text blocks in array content
        for (const block of content) {
          if (block.type === "text" && block.text && block.text.length > 0) {
            firstUserText = block.text;
            break;
          }
        }
      }
    }

    // Look for first assistant text response
    if (!firstAssistantText && entry.type === "assistant" && entry.message.role === "assistant") {
      const content = entry.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text && block.text.length > 0) {
            firstAssistantText = block.text;
            break;
          }
        }
      }
    }

    // Stop early if we have user text
    if (firstUserText) break;
  }

  // Priority: user text > assistant text > git branch > slug > short ID
  let label = firstUserText || firstAssistantText || gitBranch || slug || sessionId.slice(0, 8);

  // Clean up the label
  label = label
    .replace(/^\/\S+\s*/, "") // Remove /command prefixes
    .replace(/<[^>]+>[^<]*<\/[^>]+>/g, "") // Remove XML-style tags with content
    .replace(/<[^>]+>/g, "") // Remove remaining XML tags
    .replace(/^\s*Caveat:.*$/m, "") // Remove caveat lines
    .replace(/\n.*/g, "") // Take only first line
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F]+/g, " ") // Replace control characters with space
    .trim();

  // If still empty or too short, use fallback
  if (label.length < 3) {
    label = slug || sessionId.slice(0, 8);
  }

  // Truncate very long labels (will be smart-truncated in UI based on box size)
  if (label.length > 80) {
    label = label.slice(0, 77) + "...";
  }

  return label;
}

/**
 * Build bar chart data structure from session results.
 * Groups sessions by date and project folder, aggregating tokens per project per day.
 */
export function buildBarChartData(
  sessions: SessionResult[],
  extractProjectName: (encoded: string) => string,
): BarChartData {
  if (sessions.length === 0) {
    return { days: [] };
  }

  // Group sessions by date, then by project
  const byDateProject = new Map<string, Map<string, number>>();

  for (const session of sessions) {
    const project = extractProjectName(session.project);

    if (!byDateProject.has(session.date)) {
      byDateProject.set(session.date, new Map());
    }
    const projectMap = byDateProject.get(session.date)!;
    projectMap.set(project, (projectMap.get(project) || 0) + session.tokens);
  }

  // Build days array sorted chronologically (oldest first for x-axis)
  const sortedDates = [...byDateProject.keys()].sort();
  const days: BarChartDay[] = sortedDates.map((date) => {
    const projectMap = byDateProject.get(date)!;
    // Sort projects by total tokens descending
    const projects: ProjectBar[] = [...projectMap.entries()]
      .map(([project, totalTokens]) => ({ project, totalTokens }))
      .sort((a, b) => b.totalTokens - a.totalTokens);
    return { date, projects };
  });

  return { days };
}

interface TreemapNode {
  name: string;
  value?: number;
  children?: TreemapNode[];
  // Metadata for tooltips
  sessionId?: string;
  fullSessionId?: string;
  filePath?: string;
  startTime?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  ratio?: number;
  date?: string;
  project?: string;
  // Waste metrics
  repeatedReads?: number;
  modelEfficiency?: number; // Opus tokens / total tokens
  // Tool data
  tools?: ToolData[];
  toolName?: string; // For coloring by tool type
}

/**
 * Generate interactive HTML treemap from session token data
 */
export default class Graph extends BaseCommand {
  static override description = "Generate interactive HTML treemap from session token data";

  static override examples = [
    {
      description: "Generate treemap for all recent sessions",
      command: "<%= config.bin %> <%= command.id %>",
    },
    {
      description: "Generate treemap for a specific session",
      command: "<%= config.bin %> <%= command.id %> --session abc123",
    },
    {
      description: "Generate and auto-open in browser",
      command: "<%= config.bin %> <%= command.id %> --open",
    },
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    session: Flags.string({
      char: "s",
      description: "Session ID to analyze (shows all sessions if not provided)",
    }),
    open: Flags.boolean({
      char: "o",
      description: "Open treemap in browser after generating",
      default: true,
      allowNo: true,
    }),
    serve: Flags.boolean({
      description: "Start local HTTP server to serve treemap (default: true)",
      default: true,
      allowNo: true,
    }),
    port: Flags.integer({
      char: "p",
      description: "Port for local server",
      default: 8765,
    }),
    days: Flags.integer({
      description: "Filter to sessions from last N days (0=no limit)",
      default: 7,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Graph);

    const projectsDir = path.join(os.homedir(), ".claude", "projects");
    if (!fs.existsSync(projectsDir)) {
      this.error("No Claude projects directory found at ~/.claude/projects/");
    }

    const sessionId = flags.session;
    let treemapData: TreemapNode;
    let barChartData: BarChartData = { days: [] };

    if (!sessionId) {
      // All sessions mode
      const sessions = this.findRecentSessions(projectsDir, 500, flags.days);
      if (sessions.length === 0) {
        this.error("No sessions found");
      }

      const daysMsg = flags.days > 0 ? ` (last ${flags.days} days)` : "";
      this.log(`📊 Generating treemap for ${sessions.length} sessions${daysMsg}...`);
      treemapData = this.buildAllSessionsTreemap(sessions);
      barChartData = buildBarChartData(sessions, this.extractProjectName.bind(this));
    } else {
      // Single session mode
      const sessionPath = this.findSessionPath(projectsDir, sessionId);
      if (!sessionPath) {
        this.error(`Session ${sessionId} not found`);
      }

      this.log(`📊 Generating treemap for session ${sessionId}...`);
      const entries = this.parseJsonl(sessionPath);
      treemapData = this.buildSessionTreemap(sessionId, entries);
      // Bar chart not meaningful for single session, leave empty
    }

    // Generate HTML
    const html = this.generateTreemapHtml(treemapData, barChartData);

    // Write output file
    const reportsDir = path.join(os.homedir(), ".claude", "reports");
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    const timestamp = DateTime.now().toFormat("yyyy-MM-dd'T'HH-mmZZZ");
    const daysLabel = flags.days > 0 ? `${flags.days}d` : "all";
    const filename = sessionId
      ? `treemap-${sessionId.slice(0, 8)}-${timestamp}.html`
      : `treemap-${daysLabel}-${timestamp}.html`;
    const outputPath = path.join(reportsDir, filename);

    fs.writeFileSync(outputPath, html);
    this.log(`✓ Saved to ${outputPath}`);

    if (flags.serve) {
      // Start local HTTP server
      const server = http.createServer((req, res) => {
        // Serve the generated HTML file
        if (req.url === "/" || req.url === `/${filename}`) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(html);
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
      });

      // Try to start server, fallback to next port if in use
      const startPort = flags.port;
      const maxAttempts = 10;

      const tryPort = (port: number): Promise<number> => {
        return new Promise((resolve, reject) => {
          const onError = (err: NodeJS.ErrnoException) => {
            server.removeListener("listening", onListening);
            if (err.code === "EADDRINUSE" && port < startPort + maxAttempts - 1) {
              resolve(tryPort(port + 1));
            } else {
              reject(err);
            }
          };

          const onListening = () => {
            server.removeListener("error", onError);
            resolve(port);
          };

          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(port);
        });
      };

      const tryListen = (): Promise<number> => tryPort(startPort);

      const actualPort = await tryListen();
      const url = `http://localhost:${actualPort}/`;
      if (actualPort !== startPort) {
        this.log(`\n⚠️  Port ${startPort} in use, using ${actualPort}`);
      }
      this.log(`🌐 Server running at ${url}`);
      this.log("   Press Ctrl+C to stop\n");

      if (flags.open) {
        const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
        x(openCmd, [url]);
      }

      // Keep server running until Ctrl+C
      await new Promise<void>((resolve) => {
        process.on("SIGINT", () => {
          this.log("\n👋 Stopping server...");
          server.close();
          resolve();
        });
      });
    } else if (flags.open) {
      this.log("\n📈 Opening treemap...");
      const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
      await x(openCmd, [outputPath]);
    }
  }

  private generateTreemapHtml(data: TreemapNode, barChartData: BarChartData): string {
    const width = 1200;
    const height = 800;

    // Read template from file and replace placeholders
    // Use function replacement to avoid special $& $' $` patterns in data being interpreted
    const template = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    return template
      .replace(/\{\{WIDTH\}\}/g, String(width))
      .replace(/\{\{HEIGHT\}\}/g, String(height))
      .replace(/\{\{DATA\}\}/g, () => JSON.stringify(data))
      .replace(/\{\{BAR_CHART_DATA\}\}/g, () => JSON.stringify(barChartData));
  }

  private findRecentSessions(projectsDir: string, limit: number, days: number): SessionResult[] {
    const sessions: Array<{
      sessionId: string;
      path: string;
      date: string;
      tokens: number;
      project: string;
      mtime: number;
    }> = [];

    const cutoffMs = calculateCutoffMs(days);

    const projectDirs = fs.readdirSync(projectsDir);
    for (const project of projectDirs) {
      const projectPath = path.join(projectsDir, project);
      if (!fs.statSync(projectPath).isDirectory()) continue;

      const files = fs.readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));
      for (const file of files) {
        const filePath = path.join(projectPath, file);
        const stat = fs.statSync(filePath);

        // Filter by days if cutoff is set
        if (cutoffMs > 0 && stat.mtimeMs < cutoffMs) continue;

        const sessionId = file.replace(".jsonl", "");

        // Quick token count from file
        const tokens = this.quickTokenCount(filePath);

        sessions.push({
          sessionId,
          path: filePath,
          date: stat.mtime.toLocaleDateString("en-CA"), // YYYY-MM-DD in local timezone
          tokens,
          project,
          mtime: stat.mtimeMs,
        });
      }
    }

    // Sort by modification time, most recent first
    sessions.sort((a, b) => b.mtime - a.mtime);
    return sessions.slice(0, limit);
  }

  private quickTokenCount(filePath: string): number {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      let total = 0;
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as JournalEntry;
          if (entry.message?.usage) {
            total +=
              (entry.message.usage.input_tokens || 0) + (entry.message.usage.output_tokens || 0);
          }
        } catch {
          // Skip invalid lines
        }
      }
      return total;
    } catch {
      return 0;
    }
  }

  private findSessionPath(projectsDir: string, sessionId: string): string | undefined {
    const projectDirs = fs.readdirSync(projectsDir);
    for (const project of projectDirs) {
      const projectPath = path.join(projectsDir, project);
      if (!fs.statSync(projectPath).isDirectory()) continue;

      const jsonlPath = path.join(projectPath, `${sessionId}.jsonl`);
      if (fs.existsSync(jsonlPath)) {
        return jsonlPath;
      }
    }
    return undefined;
  }

  private parseJsonl(filePath: string): JournalEntry[] {
    return parseJsonl(filePath);
  }

  private buildSessionTreemap(sessionId: string, entries: JournalEntry[]): TreemapNode {
    return {
      name: `Session ${sessionId.slice(0, 8)}`,
      children: this.buildTurnNodes(sessionId, entries),
    };
  }

  /**
   * Build turn-level nodes from session entries.
   * Used by both single-session and all-sessions views.
   */
  private buildTurnNodes(
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
      const tools = this.extractToolData(entry.message.content, inputTokens, outputTokens);

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
        model: this.getModelName(model),
        inputTokens,
        outputTokens,
        ratio,
        tools: tools.length > 0 ? tools : undefined,
      });
    }

    return children;
  }

  /**
   * Extract individual tool calls from message content blocks.
   * Returns each tool call with its detail (file path, command, etc.).
   */
  private extractToolData(
    content: ContentBlock[] | string | undefined,
    turnInputTokens: number,
    turnOutputTokens: number,
  ): ToolData[] {
    if (!content || typeof content === "string") return [];

    // Collect individual tool_use blocks
    const toolBlocks: Array<{ name: string; detail?: string }> = [];
    for (const block of content) {
      if (block.type === "tool_use" && block.name) {
        const detail = this.extractToolDetail(block.name, block.input);
        toolBlocks.push({ name: block.name, detail });
      }
    }

    if (toolBlocks.length === 0) return [];

    // Distribute tokens proportionally across individual calls
    const tokensPerCall = {
      input: Math.round(turnInputTokens / toolBlocks.length),
      output: Math.round(turnOutputTokens / toolBlocks.length),
    };

    return toolBlocks.map((tool) => ({
      name: tool.name,
      detail: tool.detail,
      inputTokens: tokensPerCall.input,
      outputTokens: tokensPerCall.output,
    }));
  }

  /**
   * Extract a meaningful detail string from tool input.
   */
  private extractToolDetail(toolName: string, input?: Record<string, unknown>): string | undefined {
    if (!input) return undefined;

    switch (toolName) {
      case "Read":
        return this.truncateDetail(input.file_path as string);
      case "Write":
      case "Edit":
        return this.truncateDetail(input.file_path as string);
      case "Bash":
        return this.truncateDetail(input.command as string, 50);
      case "Glob":
        return this.truncateDetail(input.pattern as string, 50);
      case "Grep":
        return this.truncateDetail(input.pattern as string, 50);
      case "Task":
        return this.truncateDetail(input.description as string, 50);
      case "WebFetch":
        return this.truncateDetail(input.url as string, 40);
      default:
        return undefined;
    }
  }

  /**
   * Sanitize string by replacing control characters (newlines, tabs, etc.) with spaces.
   */
  private sanitizeString(str: string): string {
    // Replace all control characters (ASCII 0-31) with space, collapse multiple spaces
    // eslint-disable-next-line no-control-regex
    return str.replace(/[\x00-\x1F]+/g, " ").trim();
  }

  /**
   * Truncate a string and extract just the filename for paths.
   */
  private truncateDetail(str: string | undefined, maxLen = 30): string | undefined {
    if (!str) return undefined;
    // Sanitize control characters first
    const sanitized = this.sanitizeString(str);
    // For file paths, show just the filename
    if (sanitized.includes("/")) {
      const parts = sanitized.split("/");
      const filename = parts[parts.length - 1];
      return filename.length > maxLen ? filename.slice(0, maxLen - 3) + "..." : filename;
    }
    return sanitized.length > maxLen ? sanitized.slice(0, maxLen - 3) + "..." : sanitized;
  }

  /**
   * Aggregate tool usage across all entries in a session.
   * Returns combined tool data for session-level tooltips (aggregated by name).
   */
  private aggregateSessionTools(entries: JournalEntry[]): ToolData[] {
    const toolAgg = new Map<string, { count: number; inputTokens: number; outputTokens: number }>();

    for (const entry of entries) {
      if (!entry.message?.content || typeof entry.message.content === "string") continue;
      if (!entry.message.usage) continue;

      const inputTokens = entry.message.usage.input_tokens || 0;
      const outputTokens = entry.message.usage.output_tokens || 0;
      const turnTools = this.extractToolData(entry.message.content, inputTokens, outputTokens);

      for (const tool of turnTools) {
        const existing = toolAgg.get(tool.name);
        if (existing) {
          existing.count += 1;
          existing.inputTokens += tool.inputTokens;
          existing.outputTokens += tool.outputTokens;
        } else {
          toolAgg.set(tool.name, {
            count: 1,
            inputTokens: tool.inputTokens,
            outputTokens: tool.outputTokens,
          });
        }
      }
    }

    // Convert to array and sort by token usage
    const tools: ToolData[] = [...toolAgg.entries()].map(([name, data]) => ({
      name,
      detail: `${data.count}x`,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
    }));
    tools.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));

    return tools;
  }

  private buildAllSessionsTreemap(
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
      const projectName = this.extractProjectName(session.project);
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
          const entries = this.parseJsonl(session.path);
          const analysis = this.analyzeSession(entries);
          const label = this.extractSessionLabel(entries, session.sessionId);
          const tools = this.aggregateSessionTools(entries);
          const startTime = entries[0]?.timestamp
            ? new Date(entries[0].timestamp).toLocaleTimeString()
            : undefined;

          // Build turn-level children for drill-down
          const turnChildren = this.buildTurnNodes(session.sessionId, entries, session.path);

          sessionChildren.push({
            name: label,
            // If we have turn children, let them sum; otherwise use session total
            value: turnChildren.length > 0 ? undefined : session.tokens,
            children: turnChildren.length > 0 ? turnChildren : undefined,
            sessionId: session.sessionId.slice(0, 8),
            fullSessionId: session.sessionId,
            filePath: session.path,
            startTime,
            model: this.getPrimaryModel(analysis),
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

  private extractProjectName(encodedProject: string): string {
    // Directory names encode paths: -home-ctowles-code-p-towles-tool
    const parts = encodedProject.split("-").filter(Boolean);
    const pathMarkers = new Set(["code", "projects", "src", "p", "repos", "git", "workspace"]);

    // Find LAST index of a path marker
    let lastMarkerIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (pathMarkers.has(parts[i].toLowerCase())) {
        lastMarkerIdx = i;
      }
    }

    // Take everything after the last marker
    const projectParts = lastMarkerIdx >= 0 ? parts.slice(lastMarkerIdx + 1) : parts.slice(-2);

    if (projectParts.length === 0) {
      return parts[parts.length - 1] || encodedProject.slice(0, 20);
    }
    return projectParts.join("-");
  }

  private extractSessionLabel(entries: JournalEntry[], sessionId: string): string {
    return extractSessionLabel(entries, sessionId);
  }

  private analyzeSession(entries: JournalEntry[]): ReturnType<typeof analyzeSession> {
    return analyzeSession(entries);
  }

  private getPrimaryModel(analysis: ReturnType<typeof this.analyzeSession>): string {
    const { opusTokens, sonnetTokens, haikuTokens } = analysis;
    if (opusTokens >= sonnetTokens && opusTokens >= haikuTokens) return "Opus";
    if (sonnetTokens >= haikuTokens) return "Sonnet";
    return "Haiku";
  }

  private getModelName(model?: string): string {
    if (!model) return "unknown";
    if (model.includes("opus")) return "Opus";
    if (model.includes("sonnet")) return "Sonnet";
    if (model.includes("haiku")) return "Haiku";
    return model.split("-")[0] || "unknown";
  }
}
