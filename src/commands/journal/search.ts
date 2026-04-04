import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { defineCommand } from "citty";
import consola from "consola";
import { colors } from "consola/utils";
import { withSettings, debugArg } from "../shared.js";
import type { JournalType } from "../../types/journal.js";
import { JOURNAL_TYPES } from "../../types/journal.js";

export interface SearchMatch {
  filePath: string;
  lineNumber: number;
  line: string;
  context: string[];
}

export interface SearchOptions {
  query: string;
  type?: JournalType;
  startDate?: Date;
  endDate?: Date;
  contextLines?: number;
}

/**
 * Recursively collect all .md files under a directory.
 */
export function collectMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...collectMarkdownFiles(full));
    } else if (entry.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Determine journal type from a file path based on directory names.
 */
export function inferTypeFromPath(filePath: string): JournalType | null {
  const lower = filePath.toLowerCase();
  if (lower.includes("/daily-notes/") || lower.includes("daily-notes")) {
    return JOURNAL_TYPES.DAILY_NOTES;
  }
  if (lower.includes("/meetings/") || lower.includes("/meeting/")) {
    return JOURNAL_TYPES.MEETING;
  }
  if (lower.includes("/notes/") || lower.includes("/note/")) {
    return JOURNAL_TYPES.NOTE;
  }
  return null;
}

/**
 * Extract a date from a filename like `2026-03-15-*.md`.
 * Returns null if no date pattern is found.
 */
export function extractDateFromFilename(filePath: string): Date | null {
  const basename = path.basename(filePath);
  const match = basename.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

/**
 * Search journal files for a query string, returning matches with context.
 */
export function searchJournalFiles(files: string[], options: SearchOptions): SearchMatch[] {
  const { query, type, startDate, endDate, contextLines = 2 } = options;
  const lowerQuery = query.toLowerCase();
  const matches: SearchMatch[] = [];

  for (const filePath of files) {
    // Filter by type
    if (type) {
      const fileType = inferTypeFromPath(filePath);
      if (fileType !== type) continue;
    }

    // Filter by date range
    if (startDate || endDate) {
      const fileDate = extractDateFromFilename(filePath);
      if (fileDate) {
        if (startDate && fileDate < startDate) continue;
        if (endDate && fileDate > endDate) continue;
      }
    }

    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(lowerQuery)) {
        const ctxStart = Math.max(0, i - contextLines);
        const ctxEnd = Math.min(lines.length - 1, i + contextLines);
        const context: string[] = [];
        for (let j = ctxStart; j <= ctxEnd; j++) {
          const prefix = j === i ? ">" : " ";
          context.push(`${prefix} ${j + 1}: ${lines[j]}`);
        }
        matches.push({
          filePath,
          lineNumber: i + 1,
          line: lines[i],
          context,
        });
      }
    }
  }

  return matches;
}

/**
 * Parse a date range string like `2026-01-01..2026-03-01`.
 */
export function parseDateRange(range: string): { startDate: Date; endDate: Date } {
  const parts = range.split("..");
  if (parts.length !== 2) {
    throw new Error(`Invalid date range format: "${range}". Expected: YYYY-MM-DD..YYYY-MM-DD`);
  }
  const [startStr, endStr] = parts;
  const startDate = new Date(startStr);
  const endDate = new Date(endStr);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new TypeError(`Invalid dates in range: "${range}". Expected: YYYY-MM-DD..YYYY-MM-DD`);
  }
  return { startDate, endDate };
}

const VALID_TYPES = new Set<string>([
  JOURNAL_TYPES.DAILY_NOTES,
  JOURNAL_TYPES.MEETING,
  JOURNAL_TYPES.NOTE,
]);

export default defineCommand({
  meta: {
    name: "search",
    description: "Search journal entries for matching text",
  },
  args: {
    debug: debugArg,
    query: {
      type: "positional",
      required: true,
      description: "Text to search for",
    },
    type: {
      type: "string",
      alias: "t",
      description: "Filter by entry type: daily-notes, meeting, note",
    },
    range: {
      type: "string",
      alias: "r",
      description: "Filter by date range: YYYY-MM-DD..YYYY-MM-DD",
    },
  },
  async run({ args }) {
    const { settings } = await withSettings(args.debug);

    try {
      const baseFolder = settings.journalSettings.baseFolder;
      const journalDir = path.join(baseFolder, "journal");

      // Validate --type
      let typeFilter: JournalType | undefined;
      if (args.type) {
        if (!VALID_TYPES.has(args.type)) {
          consola.error(
            `Invalid type "${args.type}". Must be one of: ${[...VALID_TYPES].join(", ")}`,
          );
          process.exit(1);
        }
        typeFilter = args.type as JournalType;
      }

      // Parse --range
      let startDate: Date | undefined;
      let endDate: Date | undefined;
      if (args.range) {
        const parsed = parseDateRange(args.range);
        startDate = parsed.startDate;
        endDate = parsed.endDate;
      }

      const files = collectMarkdownFiles(journalDir);
      if (files.length === 0) {
        consola.info(`No journal files found in ${colors.cyan(journalDir)}`);
        return;
      }

      const matches = searchJournalFiles(files, {
        query: args.query,
        type: typeFilter,
        startDate,
        endDate,
      });

      if (matches.length === 0) {
        consola.info(`No matches found for "${colors.cyan(args.query)}"`);
        return;
      }

      consola.info(
        `Found ${colors.green(String(matches.length))} match(es) for "${colors.cyan(args.query)}":\n`,
      );

      // Group matches by file
      const byFile = new Map<string, SearchMatch[]>();
      for (const m of matches) {
        const existing = byFile.get(m.filePath) ?? [];
        existing.push(m);
        byFile.set(m.filePath, existing);
      }

      for (const [filePath, fileMatches] of byFile) {
        const relative = path.relative(baseFolder, filePath);
        console.log(colors.bold(colors.cyan(relative)));
        for (const m of fileMatches) {
          for (const line of m.context) {
            console.log(line);
          }
          console.log("");
        }
      }
    } catch (error) {
      consola.error(`Search failed:`, error);
      process.exit(1);
    }
  },
});
