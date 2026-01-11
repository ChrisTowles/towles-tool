import { Flags } from '@oclif/core'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { x } from 'tinyexec'
import { BaseCommand } from '../../commands/base.js'

/**
 * Calculate cutoff timestamp for days filtering.
 * Returns 0 if days <= 0 (no filtering).
 */
export function calculateCutoffMs(days: number): number {
  return days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0
}

/**
 * Filter items by mtime against a days cutoff.
 * Returns all items if days <= 0.
 */
export function filterByDays<T extends { mtime: number }>(items: T[], days: number): T[] {
  const cutoff = calculateCutoffMs(days)
  if (cutoff === 0) return items
  return items.filter((item) => item.mtime >= cutoff)
}

interface ContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

interface JournalEntry {
  type: string
  sessionId: string
  timestamp: string
  message?: {
    role: 'user' | 'assistant'
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
    content?: ContentBlock[] | string
  }
  uuid?: string
}

interface ToolData {
  name: string
  detail?: string // file path, command, etc.
  inputTokens: number
  outputTokens: number
}

interface TreemapNode {
  name: string
  value?: number
  children?: TreemapNode[]
  // Metadata for tooltips
  sessionId?: string
  fullSessionId?: string
  filePath?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  ratio?: number
  date?: string
  project?: string
  // Waste metrics
  repeatedReads?: number
  modelEfficiency?: number // Opus tokens / total tokens
  // Tool data
  tools?: ToolData[]
}

/**
 * Generate interactive HTML treemap from session token data
 */
export default class ObserveGraph extends BaseCommand {
  static override description = 'Generate interactive HTML treemap from session token data'

  static override aliases = ['observe:graph', 'graph']

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --session abc123',
    '<%= config.bin %> <%= command.id %> --open',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    session: Flags.string({
      char: 's',
      description: 'Session ID to analyze (shows all sessions if not provided)',
    }),
    open: Flags.boolean({
      char: 'o',
      description: 'Open treemap in browser after generating',
      default: true,
      allowNo: true,
    }),
    serve: Flags.boolean({
      description: 'Start local HTTP server to serve treemap (default: true)',
      default: true,
      allowNo: true,
    }),
    port: Flags.integer({
      char: 'p',
      description: 'Port for local server',
      default: 8765,
    }),
    days: Flags.integer({
      description: 'Filter to sessions from last N days (0=no limit)',
      default: 7,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(ObserveGraph)

    const projectsDir = path.join(os.homedir(), '.claude', 'projects')
    if (!fs.existsSync(projectsDir)) {
      this.error('No Claude projects directory found at ~/.claude/projects/')
    }

    const sessionId = flags.session
    let treemapData: TreemapNode

    if (!sessionId) {
      // All sessions mode
      const sessions = this.findRecentSessions(projectsDir, 500, flags.days)
      if (sessions.length === 0) {
        this.error('No sessions found')
      }

      const daysMsg = flags.days > 0 ? ` (last ${flags.days} days)` : ''
      this.log(`📊 Generating treemap for ${sessions.length} sessions${daysMsg}...`)
      treemapData = this.buildAllSessionsTreemap(sessions)
    } else {
      // Single session mode
      const sessionPath = this.findSessionPath(projectsDir, sessionId)
      if (!sessionPath) {
        this.error(`Session ${sessionId} not found`)
      }

      this.log(`📊 Generating treemap for session ${sessionId}...`)
      const entries = this.parseJsonl(sessionPath)
      treemapData = this.buildSessionTreemap(sessionId, entries)
    }

    // Generate HTML
    const html = this.generateTreemapHtml(treemapData)

    // Write output file
    const reportsDir = path.join(os.homedir(), '.claude', 'reports')
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true })
    }

    const timestamp = new Date().toISOString().split('T')[0]
    const filename = sessionId
      ? `treemap-${sessionId.slice(0, 8)}-${timestamp}.html`
      : `treemap-all-${timestamp}.html`
    const outputPath = path.join(reportsDir, filename)

    fs.writeFileSync(outputPath, html)
    this.log(`✓ Saved to ${outputPath}`)

    if (flags.serve) {
      // Start local HTTP server
      const server = http.createServer((req, res) => {
        // Serve the generated HTML file
        if (req.url === '/' || req.url === `/${filename}`) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(html)
        } else {
          res.writeHead(404)
          res.end('Not found')
        }
      })

      // Try to start server, fallback to next port if in use
      const startPort = flags.port
      const maxAttempts = 10

      const tryPort = (port: number): Promise<number> => {
        return new Promise((resolve, reject) => {
          const onError = (err: NodeJS.ErrnoException) => {
            server.removeListener('listening', onListening)
            if (err.code === 'EADDRINUSE' && port < startPort + maxAttempts - 1) {
              resolve(tryPort(port + 1))
            } else {
              reject(err)
            }
          }

          const onListening = () => {
            server.removeListener('error', onError)
            resolve(port)
          }

          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(port)
        })
      }

      const tryListen = (): Promise<number> => tryPort(startPort)

      const actualPort = await tryListen()
      const url = `http://localhost:${actualPort}/`
      if (actualPort !== startPort) {
        this.log(`\n⚠️  Port ${startPort} in use, using ${actualPort}`)
      }
      this.log(`🌐 Server running at ${url}`)
      this.log('   Press Ctrl+C to stop\n')

      if (flags.open) {
        const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
        x(openCmd, [url])
      }

      // Keep server running until Ctrl+C
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => {
          this.log('\n👋 Stopping server...')
          server.close()
          resolve()
        })
      })
    } else if (flags.open) {
      this.log('\n📈 Opening treemap...')
      const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
      await x(openCmd, [outputPath])
    }
  }

  private generateTreemapHtml(data: TreemapNode): string {
    const width = 1200
    const height = 800

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Token Treemap</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      min-height: 100vh;
      padding: 20px;
    }
    h1 {
      font-size: 1.5rem;
      margin-bottom: 15px;
      color: #fff;
    }
    .container {
      max-width: 1540px;
      margin: 0 auto;
    }
    .main-content {
      display: flex;
      gap: 20px;
    }
    .treemap-wrapper {
      flex: 1;
    }
    .detail-panel {
      width: 280px;
      flex-shrink: 0;
      background: #16213e;
      border-radius: 8px;
      padding: 16px;
      height: fit-content;
      max-height: 800px;
      overflow-y: auto;
    }
    .detail-panel.empty {
      color: #666;
      font-size: 0.9rem;
      text-align: center;
      padding: 40px 16px;
    }
    .detail-title {
      font-weight: 600;
      font-size: 1rem;
      margin-bottom: 12px;
      color: #fff;
      word-break: break-word;
    }
    .detail-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin: 6px 0;
      font-size: 0.85rem;
    }
    .detail-label { color: #888; }
    .detail-value { font-weight: 500; color: #ccc; }
    .detail-actions {
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid #333;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .detail-btn {
      background: #2a2a4a;
      border: 1px solid #444;
      color: #6b9fff;
      padding: 8px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85rem;
      text-align: left;
    }
    .detail-btn:hover {
      background: #3a3a5a;
      border-color: #666;
    }
    .legend {
      display: flex;
      gap: 20px;
      margin-bottom: 15px;
      font-size: 0.85rem;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .legend-color {
      width: 20px;
      height: 14px;
      border-radius: 3px;
    }
    #treemap {
      position: relative;
      width: ${width}px;
      height: ${height}px;
      background: #16213e;
      border-radius: 8px;
      overflow: hidden;
    }
    .node {
      position: absolute;
      overflow: hidden;
      border-radius: 3px;
      transition: opacity 0.15s;
      cursor: pointer;
    }
    .node:hover {
      opacity: 0.85;
    }
    .node-label {
      font-size: 11px;
      padding: 2px 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #fff;
      text-shadow: 0 1px 2px rgba(0,0,0,0.5);
    }
    .node-group {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
    }
    .node-group .node-label {
      font-weight: 600;
      font-size: 12px;
      color: rgba(255,255,255,0.9);
    }
    .tooltip {
      position: fixed;
      background: #2a2a4a;
      border: 1px solid #444;
      border-radius: 6px;
      padding: 12px;
      font-size: 0.85rem;
      pointer-events: none;
      z-index: 1000;
      max-width: 300px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      display: none;
    }
    .tooltip-title {
      font-weight: 600;
      margin-bottom: 8px;
      color: #fff;
    }
    .tooltip-row {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      margin: 4px 0;
      color: #ccc;
    }
    .tooltip-label { color: #888; }
    .tooltip-value { font-weight: 500; }
    .ratio-good { color: #4ade80; }
    .ratio-moderate { color: #fbbf24; }
    .ratio-high { color: #f87171; }
    .tooltip-link {
      color: #6b9fff;
      cursor: pointer;
      text-decoration: none;
    }
    .tooltip-link:hover {
      text-decoration: underline;
    }
    .tooltip-actions {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid #444;
      display: flex;
      gap: 12px;
      font-size: 0.8rem;
    }
    .tool-table {
      margin-top: 8px;
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8rem;
    }
    .tool-table th {
      text-align: left;
      color: #888;
      font-weight: 500;
      padding: 3px 6px 3px 0;
      border-bottom: 1px solid #444;
    }
    .tool-table td {
      padding: 3px 6px 3px 0;
      color: #ccc;
    }
    .tool-table td:last-child,
    .tool-table th:last-child {
      text-align: right;
      padding-right: 0;
    }
    .tool-table-header {
      color: #888;
      font-size: 0.75rem;
      margin-top: 10px;
      margin-bottom: 4px;
    }
    .stats {
      margin-top: 15px;
      font-size: 0.85rem;
      color: #888;
    }
    .breadcrumb {
      margin-bottom: 10px;
      font-size: 0.9rem;
      color: #aaa;
    }
    .crumb {
      color: #6b9fff;
    }
    .crumb:hover:not(.current) {
      text-decoration: underline;
    }
    .crumb.current {
      color: #fff;
      cursor: default;
    }
    .crumb-sep {
      color: #666;
      margin: 0 4px;
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 30px;
      margin-bottom: 15px;
      flex-wrap: wrap;
    }
    .tile-selector, .min-tokens {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tile-selector label, .min-tokens label {
      color: #888;
      font-size: 0.85rem;
    }
    .tile-selector select, .min-tokens select {
      background: #2a2a4a;
      color: #fff;
      border: 1px solid #444;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 0.85rem;
      cursor: pointer;
    }
    .tile-selector select:hover, .min-tokens select:hover {
      border-color: #666;
    }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/d3-hierarchy@3"></script>
</head>
<body>
  <div class="container">
    <h1>Claude Token Usage Treemap</h1>

    <div class="controls">
      <div class="legend">
        <div class="legend-item">
          <div class="legend-color" style="background: linear-gradient(90deg, hsl(120,70%,50%), hsl(90,70%,50%), hsl(60,70%,50%), hsl(30,70%,50%), hsl(0,70%,50%)); width: 120px;"></div>
          <span>Ratio: 1:1 → 10:1+ (green=efficient, red=wasteful)</span>
        </div>
      </div>
      <div class="tile-selector">
        <label for="tileMethod">Layout:</label>
        <select id="tileMethod">
          <option value="squarify" selected>Squarify (readable)</option>
          <option value="binary">Binary (balanced)</option>
          <option value="sliceDice">Slice & Dice (alternating)</option>
        </select>
      </div>
      <div class="min-tokens">
        <label for="minTokens">Min tokens:</label>
        <select id="minTokens">
          <option value="0">All</option>
          <option value="100">100+</option>
          <option value="500">500+</option>
          <option value="1000" selected>1K+</option>
          <option value="5000">5K+</option>
          <option value="10000">10K+</option>
        </select>
      </div>
    </div>

    <div class="main-content">
      <div class="treemap-wrapper">
        <div id="treemap"></div>
        <div class="tooltip" id="tooltip"></div>
        <div class="breadcrumb" id="breadcrumb"></div>
        <div class="stats" id="stats"></div>
      </div>
      <div class="detail-panel empty" id="detailPanel">
        Click a tile to see details
      </div>
    </div>
  </div>

  <script>
    const treeData = ${JSON.stringify(data)};
    const container = document.getElementById('treemap');
    const tooltip = document.getElementById('tooltip');
    const stats = document.getElementById('stats');
    const breadcrumb = document.getElementById('breadcrumb');
    const detailPanel = document.getElementById('detailPanel');
    const WIDTH = ${width};
    const HEIGHT = ${height};

    // Controls
    const tileMethodSelect = document.getElementById('tileMethod');
    const minTokensSelect = document.getElementById('minTokens');

    // Navigation stack for zoom
    let navStack = [treeData];

    function getCurrentNode() {
      return navStack[navStack.length - 1];
    }

    function zoomTo(node) {
      if (node.children && node.children.length > 0) {
        navStack.push(node);
        render();
      }
    }

    function zoomOut(index) {
      navStack = navStack.slice(0, index + 1);
      render();
    }

    // Filter nodes below minTokens threshold
    function filterByMinTokens(node, minTokens) {
      if (minTokens <= 0) return node;

      function sumValue(n) {
        if (n.value !== undefined && n.value > 0) return n.value;
        if (!n.children) return 0;
        return n.children.reduce((sum, c) => sum + sumValue(c), 0);
      }

      function filterNode(n) {
        const val = sumValue(n);
        if (val < minTokens && !n.children) return null;

        if (!n.children) return n;

        const filteredChildren = n.children
          .map(filterNode)
          .filter(c => c !== null);

        if (filteredChildren.length === 0 && val < minTokens) return null;

        return { ...n, children: filteredChildren.length > 0 ? filteredChildren : undefined };
      }

      return filterNode(node) || node;
    }

    // Get d3 tile method
    function getTileMethod() {
      const method = tileMethodSelect.value;
      switch (method) {
        case 'binary': return d3.treemapBinary;
        case 'sliceDice': return d3.treemapSliceDice;
        default: return d3.treemapSquarify;
      }
    }

    function computeLayout(data) {
      const minTokens = parseInt(minTokensSelect.value) || 0;
      const filteredData = filterByMinTokens(data, minTokens);

      // Use d3-hierarchy for layout
      const root = d3.hierarchy(filteredData)
        .sum(d => d.value || 0)
        .sort((a, b) => (b.value || 0) - (a.value || 0));

      const layout = d3.treemap()
        .size([WIDTH, HEIGHT])
        .paddingOuter(3)
        .paddingTop(19)
        .paddingInner(1)
        .tile(getTileMethod());

      layout(root);

      // Convert to rect array
      return root.descendants().map(d => ({
        x: d.x0,
        y: d.y0,
        width: d.x1 - d.x0,
        height: d.y1 - d.y0,
        depth: d.depth,
        name: d.data.name,
        value: d.value || 0,
        hasChildren: !!d.children?.length,
        sessionId: d.data.sessionId,
        fullSessionId: d.data.fullSessionId,
        filePath: d.data.filePath,
        model: d.data.model,
        inputTokens: d.data.inputTokens,
        outputTokens: d.data.outputTokens,
        ratio: d.data.ratio,
        date: d.data.date,
        project: d.data.project,
        repeatedReads: d.data.repeatedReads,
        modelEfficiency: d.data.modelEfficiency,
        tools: d.data.tools,
        nodeRef: d.data
      }));
    }

    // Re-render on control changes
    tileMethodSelect.addEventListener('change', render);
    minTokensSelect.addEventListener('change', render);

    function render() {
      // Clear container using replaceChildren (safe)
      container.replaceChildren();
      const currentNode = getCurrentNode();
      const rects = computeLayout(currentNode);

      // Update breadcrumb using DOM methods (safe)
      breadcrumb.replaceChildren();
      navStack.forEach((node, i) => {
        const crumb = document.createElement('span');
        crumb.className = 'crumb' + (i === navStack.length - 1 ? ' current' : '');
        crumb.textContent = node.name;
        if (i < navStack.length - 1) {
          crumb.style.cursor = 'pointer';
          crumb.onclick = () => zoomOut(i);
        }
        breadcrumb.appendChild(crumb);
        if (i < navStack.length - 1) {
          const sep = document.createElement('span');
          sep.className = 'crumb-sep';
          sep.textContent = ' > ';
          breadcrumb.appendChild(sep);
        }
      });

      // Calculate totals for current view
      let totalTokens = 0, totalInput = 0, totalOutput = 0;
      rects.forEach(r => {
        if (!r.hasChildren && r.depth > 0) {
          totalTokens += r.value || 0;
          totalInput += r.inputTokens || 0;
          totalOutput += r.outputTokens || 0;
        }
      });

      const overallRatio = totalOutput > 0 ? (totalInput / totalOutput).toFixed(1) : 'N/A';
      stats.textContent = 'Total: ' + formatTokens(totalTokens) + ' tokens | Input: ' + formatTokens(totalInput) + ' | Output: ' + formatTokens(totalOutput) + ' | Ratio: ' + overallRatio + ':1';

      // Render nodes
      rects.forEach((r) => {
        if (r.width < 1 || r.height < 1) return;

        const node = document.createElement('div');
        node.className = 'node' + (r.hasChildren ? ' node-group' : '');
        node.style.left = r.x + 'px';
        node.style.top = r.y + 'px';
        node.style.width = r.width + 'px';
        node.style.height = r.height + 'px';

        if (!r.hasChildren && r.depth > 0) {
          node.style.background = getColor(r.ratio);
        }

        if (r.width > 30 && r.height > 15) {
          const label = document.createElement('div');
          label.className = 'node-label';
          label.textContent = r.name + (r.value > 0 && !r.hasChildren ? ' (' + formatTokens(r.value) + ')' : '');
          node.appendChild(label);
        }

        // Click to zoom and/or show detail
        node.addEventListener('click', (e) => {
          e.stopPropagation();
          showDetail(r);
          if (r.hasChildren && r.nodeRef) {
            zoomTo(r.nodeRef);
          }
        });

        node.addEventListener('mouseenter', (e) => showTooltip(e, r));
        node.addEventListener('mousemove', (e) => moveTooltip(e));
        node.addEventListener('mouseleave', hideTooltip);

        container.appendChild(node);
      });
    }

    render();

    function getColor(ratio) {
      if (ratio === undefined || ratio === null) return '#4a5568';
      // Gradient from green (hue 120) through yellow (60) to red (0)
      // ratio 0-1 = green, 1-3 = green→yellow, 3-10 = yellow→red, 10+ = red
      let hue;
      if (ratio <= 1) {
        hue = 120; // Pure green
      } else if (ratio <= 3) {
        // Green to yellow (120 → 60)
        hue = 120 - ((ratio - 1) / 2) * 60;
      } else if (ratio <= 10) {
        // Yellow to red (60 → 0)
        hue = 60 - ((ratio - 3) / 7) * 60;
      } else {
        hue = 0; // Pure red
      }
      return 'hsl(' + Math.round(hue) + ', 70%, 50%)';
    }

    function getRatioClass(ratio) {
      if (ratio === undefined || ratio === null) return '';
      if (ratio < 2) return 'ratio-good';
      if (ratio < 5) return 'ratio-moderate';
      return 'ratio-high';
    }

    function formatTokens(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return n.toString();
    }

    function showTooltip(e, r) {
      // Build tooltip using DOM methods (safe from XSS)
      tooltip.replaceChildren();

      const title = document.createElement('div');
      title.className = 'tooltip-title';
      title.textContent = r.name;
      tooltip.appendChild(title);

      function addRow(label, value, extraClass) {
        const row = document.createElement('div');
        row.className = 'tooltip-row';
        const labelEl = document.createElement('span');
        labelEl.className = 'tooltip-label';
        labelEl.textContent = label;
        const valueEl = document.createElement('span');
        valueEl.className = 'tooltip-value' + (extraClass ? ' ' + extraClass : '');
        valueEl.textContent = value;
        row.appendChild(labelEl);
        row.appendChild(valueEl);
        tooltip.appendChild(row);
      }

      function addLinkRow(label, text, onClick, title) {
        const row = document.createElement('div');
        row.className = 'tooltip-row';
        const labelEl = document.createElement('span');
        labelEl.className = 'tooltip-label';
        labelEl.textContent = label;
        const link = document.createElement('span');
        link.className = 'tooltip-link';
        link.textContent = text;
        if (title) link.title = title;
        link.onclick = (e) => { e.stopPropagation(); onClick(); };
        row.appendChild(labelEl);
        row.appendChild(link);
        tooltip.appendChild(row);
      }

      if (r.sessionId) {
        addLinkRow('Session:', r.sessionId, () => {
          navigator.clipboard.writeText(r.fullSessionId || r.sessionId);
        }, 'Click to copy full session ID');
      }
      if (r.date) addRow('Date:', r.date);
      if (r.model) addRow('Model:', r.model);
      if (r.value > 0) addRow('Total tokens:', formatTokens(r.value));
      if (r.inputTokens !== undefined) addRow('Input:', formatTokens(r.inputTokens));
      if (r.outputTokens !== undefined) addRow('Output:', formatTokens(r.outputTokens));
      if (r.ratio !== undefined && r.ratio !== null) {
        addRow('Ratio (in:out):', r.ratio.toFixed(1) + ':1', getRatioClass(r.ratio));
      }
      if (r.repeatedReads !== undefined && r.repeatedReads > 0) {
        addRow('Repeated reads:', r.repeatedReads.toString());
      }
      if (r.modelEfficiency !== undefined && r.modelEfficiency > 0) {
        addRow('Opus usage:', (r.modelEfficiency * 100).toFixed(0) + '%');
      }

      // Tool breakdown table
      if (r.tools && r.tools.length > 0) {
        const header = document.createElement('div');
        header.className = 'tool-table-header';
        header.textContent = 'Tool Usage';
        tooltip.appendChild(header);

        const table = document.createElement('table');
        table.className = 'tool-table';

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        ['Tool', 'Detail', 'Tokens'].forEach(text => {
          const th = document.createElement('th');
          th.textContent = text;
          headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        r.tools.forEach(tool => {
          const tr = document.createElement('tr');
          const tdName = document.createElement('td');
          tdName.textContent = tool.name;
          const tdDetail = document.createElement('td');
          tdDetail.textContent = tool.detail || '';
          const tdTokens = document.createElement('td');
          tdTokens.textContent = formatTokens(tool.inputTokens + tool.outputTokens);
          tr.appendChild(tdName);
          tr.appendChild(tdDetail);
          tr.appendChild(tdTokens);
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        tooltip.appendChild(table);
      }

      // Actions section with links
      if (r.fullSessionId || r.filePath) {
        const actions = document.createElement('div');
        actions.className = 'tooltip-actions';

        if (r.filePath) {
          const fileLink = document.createElement('span');
          fileLink.className = 'tooltip-link';
          fileLink.textContent = '📄 Copy path';
          fileLink.title = r.filePath;
          fileLink.onclick = (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(r.filePath);
          };
          actions.appendChild(fileLink);
        }

        if (r.fullSessionId) {
          const transcriptLink = document.createElement('span');
          transcriptLink.className = 'tooltip-link';
          transcriptLink.textContent = '📜 View transcript';
          transcriptLink.title = 'Copy command to view with claude-code-transcripts';
          transcriptLink.onclick = (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText('uvx claude-code-transcripts ' + r.fullSessionId);
          };
          actions.appendChild(transcriptLink);
        }

        tooltip.appendChild(actions);
      }

      tooltip.style.display = 'block';
      moveTooltip(e);
    }

    function moveTooltip(e) {
      const x = e.clientX + 15;
      const y = e.clientY + 15;
      const rect = tooltip.getBoundingClientRect();

      tooltip.style.left = (x + rect.width > window.innerWidth ? e.clientX - rect.width - 15 : x) + 'px';
      tooltip.style.top = (y + rect.height > window.innerHeight ? e.clientY - rect.height - 15 : y) + 'px';
    }

    function hideTooltip() {
      tooltip.style.display = 'none';
    }

    function showDetail(r) {
      detailPanel.className = 'detail-panel';
      detailPanel.replaceChildren();

      const title = document.createElement('div');
      title.className = 'detail-title';
      title.textContent = r.name;
      detailPanel.appendChild(title);

      function addDetailRow(label, value, extraClass) {
        const row = document.createElement('div');
        row.className = 'detail-row';
        const labelEl = document.createElement('span');
        labelEl.className = 'detail-label';
        labelEl.textContent = label;
        const valueEl = document.createElement('span');
        valueEl.className = 'detail-value' + (extraClass ? ' ' + extraClass : '');
        valueEl.textContent = value;
        row.appendChild(labelEl);
        row.appendChild(valueEl);
        detailPanel.appendChild(row);
      }

      if (r.sessionId) addDetailRow('Session:', r.fullSessionId || r.sessionId);
      if (r.date) addDetailRow('Date:', r.date);
      if (r.model) addDetailRow('Model:', r.model);
      if (r.value > 0) addDetailRow('Total tokens:', formatTokens(r.value));
      if (r.inputTokens !== undefined) addDetailRow('Input:', formatTokens(r.inputTokens));
      if (r.outputTokens !== undefined) addDetailRow('Output:', formatTokens(r.outputTokens));
      if (r.ratio !== undefined && r.ratio !== null) {
        addDetailRow('Ratio (in:out):', r.ratio.toFixed(1) + ':1', getRatioClass(r.ratio));
      }

      // Action buttons
      if (r.fullSessionId || r.filePath) {
        const actions = document.createElement('div');
        actions.className = 'detail-actions';

        if (r.filePath) {
          const fileBtn = document.createElement('button');
          fileBtn.className = 'detail-btn';
          fileBtn.textContent = '📄 Copy file path';
          fileBtn.onclick = () => {
            navigator.clipboard.writeText(r.filePath);
            fileBtn.textContent = '✓ Copied!';
            setTimeout(() => fileBtn.textContent = '📄 Copy file path', 1500);
          };
          actions.appendChild(fileBtn);
        }

        if (r.fullSessionId) {
          const copyIdBtn = document.createElement('button');
          copyIdBtn.className = 'detail-btn';
          copyIdBtn.textContent = '🔗 Copy session ID';
          copyIdBtn.onclick = () => {
            navigator.clipboard.writeText(r.fullSessionId);
            copyIdBtn.textContent = '✓ Copied!';
            setTimeout(() => copyIdBtn.textContent = '🔗 Copy session ID', 1500);
          };
          actions.appendChild(copyIdBtn);

          const transcriptBtn = document.createElement('button');
          transcriptBtn.className = 'detail-btn';
          transcriptBtn.textContent = '📜 Copy transcript command';
          transcriptBtn.onclick = () => {
            navigator.clipboard.writeText('uvx claude-code-transcripts ' + r.fullSessionId);
            transcriptBtn.textContent = '✓ Copied!';
            setTimeout(() => transcriptBtn.textContent = '📜 Copy transcript command', 1500);
          };
          actions.appendChild(transcriptBtn);
        }

        detailPanel.appendChild(actions);
      }
    }
  </script>
</body>
</html>`
  }

  private findRecentSessions(
    projectsDir: string,
    limit: number,
    days: number
  ): Array<{ sessionId: string; path: string; date: string; tokens: number; project: string }> {
    const sessions: Array<{
      sessionId: string
      path: string
      date: string
      tokens: number
      project: string
      mtime: number
    }> = []

    const cutoffMs = calculateCutoffMs(days)

    const projectDirs = fs.readdirSync(projectsDir)
    for (const project of projectDirs) {
      const projectPath = path.join(projectsDir, project)
      if (!fs.statSync(projectPath).isDirectory()) continue

      const files = fs.readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'))
      for (const file of files) {
        const filePath = path.join(projectPath, file)
        const stat = fs.statSync(filePath)

        // Filter by days if cutoff is set
        if (cutoffMs > 0 && stat.mtimeMs < cutoffMs) continue

        const sessionId = file.replace('.jsonl', '')

        // Quick token count from file
        const tokens = this.quickTokenCount(filePath)

        sessions.push({
          sessionId,
          path: filePath,
          date: stat.mtime.toISOString().split('T')[0],
          tokens,
          project,
          mtime: stat.mtimeMs,
        })
      }
    }

    // Sort by modification time, most recent first
    sessions.sort((a, b) => b.mtime - a.mtime)
    return sessions.slice(0, limit)
  }

  private quickTokenCount(filePath: string): number {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      let total = 0
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as JournalEntry
          if (entry.message?.usage) {
            total +=
              (entry.message.usage.input_tokens || 0) + (entry.message.usage.output_tokens || 0)
          }
        } catch {
          // Skip invalid lines
        }
      }
      return total
    } catch {
      return 0
    }
  }

  private findSessionPath(projectsDir: string, sessionId: string): string | undefined {
    const projectDirs = fs.readdirSync(projectsDir)
    for (const project of projectDirs) {
      const projectPath = path.join(projectsDir, project)
      if (!fs.statSync(projectPath).isDirectory()) continue

      const jsonlPath = path.join(projectPath, `${sessionId}.jsonl`)
      if (fs.existsSync(jsonlPath)) {
        return jsonlPath
      }
    }
    return undefined
  }

  private parseJsonl(filePath: string): JournalEntry[] {
    const content = fs.readFileSync(filePath, 'utf-8')
    const entries: JournalEntry[] = []

    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line) as JournalEntry)
      } catch {
        // Skip invalid lines
      }
    }

    return entries
  }

  private buildSessionTreemap(sessionId: string, entries: JournalEntry[]): TreemapNode {
    return {
      name: `Session ${sessionId.slice(0, 8)}`,
      children: this.buildTurnNodes(sessionId, entries),
    }
  }

  /**
   * Build turn-level nodes from session entries.
   * Used by both single-session and all-sessions views.
   */
  private buildTurnNodes(sessionId: string, entries: JournalEntry[], filePath?: string): TreemapNode[] {
    const children: TreemapNode[] = []
    let turnNumber = 0

    for (const entry of entries) {
      if (entry.type !== 'user' && entry.type !== 'assistant') continue
      if (!entry.message) continue

      const role = entry.message.role
      const usage = entry.message.usage
      const model = entry.message.model

      if (role === 'user') {
        turnNumber++
      }

      if (!usage) continue

      const inputTokens = usage.input_tokens || 0
      const outputTokens = usage.output_tokens || 0
      const totalTokens = inputTokens + outputTokens

      if (totalTokens === 0) continue

      const ratio = outputTokens > 0 ? inputTokens / outputTokens : inputTokens > 0 ? 999 : 0

      // Extract individual tool calls from content blocks
      const tools = this.extractToolData(entry.message.content, inputTokens, outputTokens)

      // Create individual tool children nodes
      const toolChildren: TreemapNode[] = tools.map((tool) => ({
        name: tool.detail ? `${tool.name}: ${tool.detail}` : tool.name,
        value: tool.inputTokens + tool.outputTokens,
        inputTokens: tool.inputTokens,
        outputTokens: tool.outputTokens,
        ratio: tool.outputTokens > 0 ? tool.inputTokens / tool.outputTokens : 0,
      }))

      // Format turn name based on tools used
      let turnName: string
      if (role === 'user') {
        turnName = `Turn ${turnNumber}: User`
      } else if (tools.length === 1) {
        // Single tool: show tool name and detail
        const t = tools[0]
        turnName = t.detail ? `${t.name}: ${t.detail}` : t.name
      } else if (tools.length > 1) {
        // Multiple tools: list unique tool names
        const uniqueNames = [...new Set(tools.map((t) => t.name))]
        turnName = uniqueNames.slice(0, 3).join(', ') + (uniqueNames.length > 3 ? '...' : '')
      } else {
        turnName = `Turn ${turnNumber}: Response`
      }
      children.push({
        name: turnName,
        value: toolChildren.length > 0 ? undefined : totalTokens, // Let children sum if present
        children: toolChildren.length > 0 ? toolChildren : undefined,
        sessionId: sessionId.slice(0, 8),
        fullSessionId: sessionId,
        filePath,
        model: this.getModelName(model),
        inputTokens,
        outputTokens,
        ratio,
        tools: tools.length > 0 ? tools : undefined,
      })
    }

    return children
  }

  /**
   * Extract individual tool calls from message content blocks.
   * Returns each tool call with its detail (file path, command, etc.).
   */
  private extractToolData(
    content: ContentBlock[] | string | undefined,
    turnInputTokens: number,
    turnOutputTokens: number
  ): ToolData[] {
    if (!content || typeof content === 'string') return []

    // Collect individual tool_use blocks
    const toolBlocks: Array<{ name: string; detail?: string }> = []
    for (const block of content) {
      if (block.type === 'tool_use' && block.name) {
        const detail = this.extractToolDetail(block.name, block.input)
        toolBlocks.push({ name: block.name, detail })
      }
    }

    if (toolBlocks.length === 0) return []

    // Distribute tokens proportionally across individual calls
    const tokensPerCall = {
      input: Math.round(turnInputTokens / toolBlocks.length),
      output: Math.round(turnOutputTokens / toolBlocks.length),
    }

    return toolBlocks.map((tool) => ({
      name: tool.name,
      detail: tool.detail,
      inputTokens: tokensPerCall.input,
      outputTokens: tokensPerCall.output,
    }))
  }

  /**
   * Extract a meaningful detail string from tool input.
   */
  private extractToolDetail(toolName: string, input?: Record<string, unknown>): string | undefined {
    if (!input) return undefined

    switch (toolName) {
      case 'Read':
        return this.truncateDetail(input.file_path as string)
      case 'Write':
      case 'Edit':
        return this.truncateDetail(input.file_path as string)
      case 'Bash':
        return this.truncateDetail(input.command as string, 50)
      case 'Glob':
        return input.pattern as string
      case 'Grep':
        return input.pattern as string
      case 'Task':
        return input.description as string
      case 'WebFetch':
        return this.truncateDetail(input.url as string, 40)
      default:
        return undefined
    }
  }

  /**
   * Truncate a string and extract just the filename for paths.
   */
  private truncateDetail(str: string | undefined, maxLen = 30): string | undefined {
    if (!str) return undefined
    // For file paths, show just the filename
    if (str.includes('/')) {
      const parts = str.split('/')
      const filename = parts[parts.length - 1]
      return filename.length > maxLen ? filename.slice(0, maxLen - 3) + '...' : filename
    }
    return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str
  }

  /**
   * Aggregate tool usage across all entries in a session.
   * Returns combined tool data for session-level tooltips (aggregated by name).
   */
  private aggregateSessionTools(entries: JournalEntry[]): ToolData[] {
    const toolAgg = new Map<string, { count: number; inputTokens: number; outputTokens: number }>()

    for (const entry of entries) {
      if (!entry.message?.content || typeof entry.message.content === 'string') continue
      if (!entry.message.usage) continue

      const inputTokens = entry.message.usage.input_tokens || 0
      const outputTokens = entry.message.usage.output_tokens || 0
      const turnTools = this.extractToolData(entry.message.content, inputTokens, outputTokens)

      for (const tool of turnTools) {
        const existing = toolAgg.get(tool.name)
        if (existing) {
          existing.count += 1
          existing.inputTokens += tool.inputTokens
          existing.outputTokens += tool.outputTokens
        } else {
          toolAgg.set(tool.name, {
            count: 1,
            inputTokens: tool.inputTokens,
            outputTokens: tool.outputTokens,
          })
        }
      }
    }

    // Convert to array and sort by token usage
    const tools: ToolData[] = [...toolAgg.entries()].map(([name, data]) => ({
      name,
      detail: `${data.count}x`,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
    }))
    tools.sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))

    return tools
  }

  private buildAllSessionsTreemap(
    sessions: Array<{ sessionId: string; path: string; date: string; tokens: number; project: string }>
  ): TreemapNode {
    // Group sessions by project, then by date
    const byProject = new Map<string, typeof sessions>()
    for (const session of sessions) {
      const projectName = this.extractProjectName(session.project)
      if (!byProject.has(projectName)) {
        byProject.set(projectName, [])
      }
      byProject.get(projectName)!.push(session)
    }

    // Sort projects by total tokens
    const projectTotals = [...byProject.entries()].map(([name, sess]) => ({
      name,
      sessions: sess,
      total: sess.reduce((sum, s) => sum + s.tokens, 0),
    }))
    projectTotals.sort((a, b) => b.total - a.total)

    const projectChildren: TreemapNode[] = []

    for (const { name: projectName, sessions: projectSessions } of projectTotals) {
      // Group by date within project
      const byDate = new Map<string, typeof sessions>()
      for (const session of projectSessions) {
        if (!byDate.has(session.date)) {
          byDate.set(session.date, [])
        }
        byDate.get(session.date)!.push(session)
      }

      // Sort dates (most recent first)
      const sortedDates = [...byDate.keys()].sort().reverse()

      const dateChildren: TreemapNode[] = []

      for (const date of sortedDates) {
        const dateSessions = byDate.get(date)!

        const sessionChildren: TreemapNode[] = []

        for (const session of dateSessions) {
          const entries = this.parseJsonl(session.path)
          const analysis = this.analyzeSession(entries)
          const label = this.extractSessionLabel(entries, session.sessionId)
          const tools = this.aggregateSessionTools(entries)

          // Build turn-level children for drill-down
          const turnChildren = this.buildTurnNodes(session.sessionId, entries, session.path)

          sessionChildren.push({
            name: label,
            // If we have turn children, let them sum; otherwise use session total
            value: turnChildren.length > 0 ? undefined : session.tokens,
            children: turnChildren.length > 0 ? turnChildren : undefined,
            sessionId: session.sessionId.slice(0, 8),
            fullSessionId: session.sessionId,
            filePath: session.path,
            model: this.getPrimaryModel(analysis),
            inputTokens: analysis.inputTokens,
            outputTokens: analysis.outputTokens,
            ratio: analysis.outputTokens > 0 ? analysis.inputTokens / analysis.outputTokens : 0,
            date: session.date,
            project: projectName,
            repeatedReads: analysis.repeatedReads,
            modelEfficiency: analysis.modelEfficiency,
            tools: tools.length > 0 ? tools : undefined,
          })
        }

        dateChildren.push({
          name: date,
          children: sessionChildren,
          date,
        })
      }

      projectChildren.push({
        name: projectName,
        children: dateChildren,
        project: projectName,
      })
    }

    return {
      name: 'All Sessions',
      children: projectChildren,
    }
  }

  private extractProjectName(encodedProject: string): string {
    // Directory names encode paths: -home-ctowles-code-p-towles-tool
    const parts = encodedProject.split('-').filter(Boolean)
    const pathMarkers = new Set(['code', 'projects', 'src', 'p', 'repos', 'git', 'workspace'])

    // Find LAST index of a path marker
    let lastMarkerIdx = -1
    for (let i = 0; i < parts.length; i++) {
      if (pathMarkers.has(parts[i].toLowerCase())) {
        lastMarkerIdx = i
      }
    }

    // Take everything after the last marker
    const projectParts = lastMarkerIdx >= 0 ? parts.slice(lastMarkerIdx + 1) : parts.slice(-2)

    if (projectParts.length === 0) {
      return parts[parts.length - 1] || encodedProject.slice(0, 20)
    }
    return projectParts.join('-')
  }

  /**
   * Extract a meaningful label from session entries.
   * Priority: first user text > first assistant response > git branch > slug > short ID
   */
  private extractSessionLabel(entries: JournalEntry[], sessionId: string): string {
    let firstUserText: string | undefined
    let firstAssistantText: string | undefined
    let gitBranch: string | undefined
    let slug: string | undefined

    for (const entry of entries) {
      // Extract metadata from any entry
      if (!gitBranch && (entry as any).gitBranch) {
        gitBranch = (entry as any).gitBranch
      }
      if (!slug && (entry as any).slug) {
        slug = (entry as any).slug
      }

      if (!entry.message) continue

      // Look for first user message with actual text (not UUID reference)
      if (!firstUserText && entry.type === 'user' && entry.message.role === 'user') {
        const content = entry.message.content
        if (typeof content === 'string') {
          // Check if it's a UUID (skip those) or actual text
          const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(content)
          if (!isUuid && content.length > 0) {
            firstUserText = content
          }
        } else if (Array.isArray(content)) {
          // Look for text blocks in array content
          for (const block of content) {
            if (block.type === 'text' && block.text && block.text.length > 0) {
              firstUserText = block.text
              break
            }
          }
        }
      }

      // Look for first assistant text response
      if (!firstAssistantText && entry.type === 'assistant' && entry.message.role === 'assistant') {
        const content = entry.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text && block.text.length > 0) {
              firstAssistantText = block.text
              break
            }
          }
        }
      }

      // Stop early if we have user text
      if (firstUserText) break
    }

    // Priority: user text > assistant text > git branch > slug > short ID
    let label = firstUserText || firstAssistantText || gitBranch || slug || sessionId.slice(0, 8)

    // Clean up the label
    label = label
      .replace(/^\/\S+\s*/, '') // Remove /command prefixes
      .replace(/<[^>]+>[^<]*<\/[^>]+>/g, '') // Remove XML-style tags with content
      .replace(/<[^>]+>/g, '') // Remove remaining XML tags
      .replace(/^\s*Caveat:.*$/m, '') // Remove caveat lines
      .replace(/\n.*/g, '') // Take only first line
      .trim()

    // If still empty or too short, use fallback
    if (label.length < 3) {
      label = slug || sessionId.slice(0, 8)
    }

    // Truncate very long labels (will be smart-truncated in UI based on box size)
    if (label.length > 80) {
      label = label.slice(0, 77) + '...'
    }

    return label
  }

  private analyzeSession(entries: JournalEntry[]): {
    inputTokens: number
    outputTokens: number
    opusTokens: number
    sonnetTokens: number
    haikuTokens: number
    cacheHitRate: number
    repeatedReads: number
    modelEfficiency: number
  } {
    let inputTokens = 0
    let outputTokens = 0
    let opusTokens = 0
    let sonnetTokens = 0
    let haikuTokens = 0
    let cacheRead = 0
    let totalInput = 0
    const fileReadCounts = new Map<string, number>()

    for (const entry of entries) {
      // Count file reads for repeatedReads metric
      if (entry.message?.content && Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'tool_use' && block.name === 'Read' && block.input) {
            const filePath = (block.input as { file_path?: string }).file_path
            if (filePath) {
              fileReadCounts.set(filePath, (fileReadCounts.get(filePath) || 0) + 1)
            }
          }
        }
      }

      if (!entry.message?.usage) continue
      const usage = entry.message.usage
      const model = entry.message.model || ''
      const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0)

      inputTokens += usage.input_tokens || 0
      outputTokens += usage.output_tokens || 0
      cacheRead += usage.cache_read_input_tokens || 0
      totalInput += usage.input_tokens || 0

      if (model.includes('opus')) opusTokens += tokens
      else if (model.includes('sonnet')) sonnetTokens += tokens
      else if (model.includes('haiku')) haikuTokens += tokens
    }

    // Count files read more than once
    let repeatedReads = 0
    for (const count of fileReadCounts.values()) {
      if (count > 1) repeatedReads += count - 1
    }

    const totalTokens = opusTokens + sonnetTokens + haikuTokens

    return {
      inputTokens,
      outputTokens,
      opusTokens,
      sonnetTokens,
      haikuTokens,
      cacheHitRate: totalInput > 0 ? cacheRead / totalInput : 0,
      repeatedReads,
      modelEfficiency: totalTokens > 0 ? opusTokens / totalTokens : 0,
    }
  }

  private getPrimaryModel(analysis: ReturnType<typeof this.analyzeSession>): string {
    const { opusTokens, sonnetTokens, haikuTokens } = analysis
    if (opusTokens >= sonnetTokens && opusTokens >= haikuTokens) return 'Opus'
    if (sonnetTokens >= haikuTokens) return 'Sonnet'
    return 'Haiku'
  }

  private getModelName(model?: string): string {
    if (!model) return 'unknown'
    if (model.includes('opus')) return 'Opus'
    if (model.includes('sonnet')) return 'Sonnet'
    if (model.includes('haiku')) return 'Haiku'
    return model.split('-')[0] || 'unknown'
  }
}
