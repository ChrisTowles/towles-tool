// Types for parsing Claude Code session JSONL files
export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface JournalEntry {
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

export interface ToolData {
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

export interface TreemapNode {
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
