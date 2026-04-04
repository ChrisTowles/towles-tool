import { statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { defineCommand } from "citty";
import consola from "consola";
import { colors } from "consola/utils";
import { withSettings, debugArg } from "../shared.js";
import type { JournalType } from "../../types/journal.js";
import { JOURNAL_TYPES } from "../../types/journal.js";
import { collectMarkdownFiles, inferTypeFromPath, extractDateFromFilename } from "./search.js";

export interface JournalEntry {
  filePath: string;
  relativePath: string;
  type: JournalType | null;
  date: Date | null;
  size: number;
}

export interface ListOptions {
  type?: JournalType;
  limit: number;
  sort: "date" | "name";
}

/**
 * Collect journal entries with metadata from a list of file paths.
 */
export function collectJournalEntries(files: string[], baseDir: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const filePath of files) {
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch {
      continue;
    }
    entries.push({
      filePath,
      relativePath: path.relative(baseDir, filePath),
      type: inferTypeFromPath(filePath),
      date: extractDateFromFilename(filePath),
      size,
    });
  }
  return entries;
}

/**
 * Filter and sort journal entries based on options.
 */
export function filterAndSortEntries(
  entries: JournalEntry[],
  options: ListOptions,
): JournalEntry[] {
  let filtered = entries;

  if (options.type) {
    filtered = filtered.filter((e) => e.type === options.type);
  }

  filtered.sort((a, b) => {
    if (options.sort === "date") {
      const dateA = a.date?.getTime() ?? 0;
      const dateB = b.date?.getTime() ?? 0;
      return dateB - dateA; // newest first
    }
    return a.relativePath.localeCompare(b.relativePath);
  });

  return filtered.slice(0, options.limit);
}

/**
 * Format a file size in bytes to a human-readable string.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}MB`;
}

/**
 * Format a date as YYYY-MM-DD or return "-" if null.
 */
export function formatDate(date: Date | null): string {
  if (!date) return "-";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Render journal entries as a formatted table.
 */
export function renderTable(entries: JournalEntry[]): string {
  const header = { file: "FILE", type: "TYPE", date: "DATE", size: "SIZE" };
  const rows = entries.map((e) => ({
    file: e.relativePath,
    type: e.type ?? "unknown",
    date: formatDate(e.date),
    size: formatSize(e.size),
  }));

  const allRows = [header, ...rows];
  const colWidths = {
    file: Math.max(...allRows.map((r) => r.file.length)),
    type: Math.max(...allRows.map((r) => r.type.length)),
    date: Math.max(...allRows.map((r) => r.date.length)),
    size: Math.max(...allRows.map((r) => r.size.length)),
  };

  const lines: string[] = [];
  for (const row of allRows) {
    const line = [
      row.file.padEnd(colWidths.file),
      row.type.padEnd(colWidths.type),
      row.date.padEnd(colWidths.date),
      row.size.padStart(colWidths.size),
    ].join("  ");
    lines.push(line);
  }

  return lines.join("\n");
}

const VALID_TYPES = new Set<string>([
  JOURNAL_TYPES.DAILY_NOTES,
  JOURNAL_TYPES.MEETING,
  JOURNAL_TYPES.NOTE,
]);

export default defineCommand({
  meta: {
    name: "list",
    description: "List recent journal entries",
  },
  args: {
    debug: debugArg,
    type: {
      type: "string",
      alias: "t",
      description: "Filter by entry type: daily-notes, meeting, note",
    },
    limit: {
      type: "string",
      alias: "l",
      description: "Maximum number of entries to show (default: 20)",
    },
    sort: {
      type: "string",
      alias: "s",
      description: "Sort by: date, name (default: date)",
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

      // Parse --limit
      const limit = args.limit ? Number.parseInt(args.limit, 10) : 20;
      if (Number.isNaN(limit) || limit < 1) {
        consola.error(`Invalid limit "${args.limit}". Must be a positive integer.`);
        process.exit(1);
      }

      // Validate --sort
      const sort = (args.sort ?? "date") as "date" | "name";
      if (sort !== "date" && sort !== "name") {
        consola.error(`Invalid sort "${args.sort}". Must be one of: date, name`);
        process.exit(1);
      }

      const files = collectMarkdownFiles(journalDir);
      if (files.length === 0) {
        consola.info(`No journal files found in ${colors.cyan(journalDir)}`);
        return;
      }

      const entries = collectJournalEntries(files, baseFolder);
      const result = filterAndSortEntries(entries, { type: typeFilter, limit, sort });

      if (result.length === 0) {
        consola.info("No matching journal entries found.");
        return;
      }

      consola.info(`Showing ${colors.green(String(result.length))} journal entries:\n`);
      console.log(renderTable(result));
    } catch (error) {
      consola.error("Failed to list journal entries:", error);
      process.exit(1);
    }
  },
});
