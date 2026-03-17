import * as fs from "node:fs";
import type { JournalEntry } from "./types.js";

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
 * Quick token count from a JSONL file without full parsing.
 */
export function quickTokenCount(filePath: string): number {
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
    // File unreadable or missing — treat token count as 0
    return 0;
  }
}
