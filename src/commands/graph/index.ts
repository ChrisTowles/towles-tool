import { Flags } from "@oclif/core";
import { DateTime } from "luxon";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { x } from "tinyexec";
import { BaseCommand } from "../base.js";
import { parseJsonl } from "./parser.js";
import {
  buildAllSessionsTreemap,
  buildBarChartData,
  buildSessionTreemap,
  findRecentSessions,
  findSessionPath,
  generateTreemapHtml,
} from "./render.js";
import { openInBrowser, startServer, waitForShutdown } from "./server.js";

// Re-export public API for consumers and tests
export { calculateCutoffMs, filterByDays, parseJsonl } from "./parser.js";
export { analyzeSession, extractSessionLabel } from "./analyzer.js";
export {
  buildBarChartData,
  buildAllSessionsTreemap,
  buildSessionTreemap,
  generateTreemapHtml,
  findRecentSessions,
  findSessionPath,
} from "./render.js";
export type { BarChartData, BarChartDay, ProjectBar, SessionResult, TreemapNode } from "./types.js";

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
    let treemapData;
    let barChartData = { days: [] as any[] };

    if (!sessionId) {
      // All sessions mode
      const sessions = findRecentSessions(projectsDir, 500, flags.days);
      if (sessions.length === 0) {
        this.error("No sessions found");
      }

      const daysMsg = flags.days > 0 ? ` (last ${flags.days} days)` : "";
      this.log(`📊 Generating treemap for ${sessions.length} sessions${daysMsg}...`);
      treemapData = buildAllSessionsTreemap(sessions);
      barChartData = buildBarChartData(sessions);
    } else {
      // Single session mode
      const sessionPath = findSessionPath(projectsDir, sessionId);
      if (!sessionPath) {
        this.error(`Session ${sessionId} not found`);
      }

      this.log(`📊 Generating treemap for session ${sessionId}...`);
      const entries = parseJsonl(sessionPath);
      treemapData = buildSessionTreemap(sessionId, entries);
      // Bar chart not meaningful for single session, leave empty
    }

    // Generate HTML
    const html = generateTreemapHtml(treemapData, barChartData);

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
      const { server, port: actualPort } = await startServer(html, filename, flags.port);
      const url = `http://localhost:${actualPort}/`;
      if (actualPort !== flags.port) {
        this.log(`\n⚠️  Port ${flags.port} in use, using ${actualPort}`);
      }
      this.log(`🌐 Server running at ${url}`);
      this.log("   Press Ctrl+C to stop\n");

      if (flags.open) {
        openInBrowser(url);
      }

      // Keep server running until Ctrl+C
      await waitForShutdown(server);
      this.log("\n👋 Stopping server...");
    } else if (flags.open) {
      this.log("\n📈 Opening treemap...");
      const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
      await x(openCmd, [outputPath]);
    }
  }
}
