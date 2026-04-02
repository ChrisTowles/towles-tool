import { defineCommand } from "citty";
import { DateTime } from "luxon";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { x } from "tinyexec";
import consola from "consola";

import { debugArg } from "../shared.js";
import { buildAllSessionsTreemap, buildSessionTreemap } from "./treemap.js";
import { buildBarChartData, findRecentSessions, findSessionPath } from "./sessions.js";
import { generateTreemapHtml } from "./render.js";
import { openInBrowser, startServer, waitForShutdown } from "./server.js";
import { parseJsonl } from "./parser.js";

// Re-export public API for consumers and tests
export { analyzeSession } from "./analyzer.js";
export { buildAllSessionsTreemap, buildSessionTreemap } from "./treemap.js";
export { buildBarChartData, findRecentSessions, findSessionPath } from "./sessions.js";
export { calculateCutoffMs, filterByDays, parseJsonl } from "./parser.js";
export { extractSessionLabel } from "./labels.js";
export { generateTreemapHtml } from "./render.js";
export type { BarChartData, BarChartDay, ProjectBar, SessionResult, TreemapNode } from "./types.js";

export default defineCommand({
  meta: { name: "graph", description: "Generate interactive HTML treemap from session token data" },
  args: {
    debug: debugArg,
    session: {
      type: "string" as const,
      alias: "s",
      description: "Session ID to analyze (shows all sessions if not provided)",
    },
    open: {
      type: "boolean" as const,
      alias: "o",
      description: "Open treemap in browser after generating",
      default: true,
    },
    serve: {
      type: "boolean" as const,
      description: "Start local HTTP server to serve treemap (default: true)",
      default: true,
    },
    port: {
      type: "string" as const,
      alias: "p",
      description: "Port for local server (default: 8765)",
      default: "8765",
    },
    days: {
      type: "string" as const,
      description: "Filter to sessions from last N days (0=no limit, default: 7)",
      default: "7",
    },
  },
  async run({ args }) {
    const port = Number(args.port);
    const days = Number(args.days);

    const projectsDir = path.join(os.homedir(), ".claude", "projects");
    if (!fs.existsSync(projectsDir)) {
      consola.error("No Claude projects directory found at ~/.claude/projects/");
      process.exit(1);
    }

    const sessionId = args.session;
    let treemapData;
    let barChartData = { days: [] as any[] };

    if (!sessionId) {
      // All sessions mode
      const sessions = findRecentSessions(projectsDir, 500, days);
      if (sessions.length === 0) {
        consola.error("No sessions found");
        process.exit(1);
      }

      const daysMsg = days > 0 ? ` (last ${days} days)` : "";
      consola.info(`📊 Generating treemap for ${sessions.length} sessions${daysMsg}...`);
      treemapData = buildAllSessionsTreemap(sessions);
      barChartData = buildBarChartData(sessions);
    } else {
      // Single session mode
      const sessionPath = findSessionPath(projectsDir, sessionId);
      if (!sessionPath) {
        consola.error(`Session ${sessionId} not found`);
        process.exit(1);
      }

      consola.info(`📊 Generating treemap for session ${sessionId}...`);
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
    const daysLabel = days > 0 ? `${days}d` : "all";
    const filename = sessionId
      ? `treemap-${sessionId.slice(0, 8)}-${timestamp}.html`
      : `treemap-${daysLabel}-${timestamp}.html`;
    const outputPath = path.join(reportsDir, filename);

    fs.writeFileSync(outputPath, html);
    consola.info(`✓ Saved to ${outputPath}`);

    if (args.serve) {
      const { server, port: actualPort } = await startServer(html, filename, port);
      const url = `http://localhost:${actualPort}/`;
      if (actualPort !== port) {
        consola.info(`\n⚠️  Port ${port} in use, using ${actualPort}`);
      }
      consola.info(`🌐 Server running at ${url}`);
      consola.info("   Press Ctrl+C to stop\n");

      if (args.open) {
        openInBrowser(url);
      }

      // Keep server running until Ctrl+C
      await waitForShutdown(server);
      consola.info("\n👋 Stopping server...");
    } else if (args.open) {
      consola.info("\n📈 Opening treemap...");
      const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
      await x(openCmd, [outputPath]);
    }
  },
});
