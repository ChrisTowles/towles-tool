import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { BarChartData, TreemapNode } from "./types.js";

// Load HTML template from file (resolved relative to this module)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "..", "graph-template.html");
let _cachedTemplate: string | undefined;
function getTemplate(): string {
  _cachedTemplate ??= fs.readFileSync(TEMPLATE_PATH, "utf-8");
  return _cachedTemplate;
}

/**
 * Generate HTML from treemap data and bar chart data using the template.
 */
export function generateTreemapHtml(data: TreemapNode, barChartData: BarChartData): string {
  const width = 1200;
  const height = 800;
  // Use function replacement to avoid special $& $' $` patterns in data being interpreted
  return getTemplate()
    .replace(/\{\{WIDTH\}\}/g, String(width))
    .replace(/\{\{HEIGHT\}\}/g, String(height))
    .replace(/\{\{DATA\}\}/g, () => JSON.stringify(data))
    .replace(/\{\{BAR_CHART_DATA\}\}/g, () => JSON.stringify(barChartData));
}
