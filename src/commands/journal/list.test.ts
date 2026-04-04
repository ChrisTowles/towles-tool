import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  collectJournalEntries,
  filterAndSortEntries,
  formatSize,
  formatDate,
  renderTable,
} from "./list.js";
import type { JournalEntry } from "./list.js";
import { JOURNAL_TYPES } from "../../types/journal.js";

describe("journal list", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(tmpdir(), `journal-list-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("collectJournalEntries", () => {
    it("collects entries with metadata", () => {
      const dailyDir = path.join(tmpDir, "daily-notes");
      mkdirSync(dailyDir, { recursive: true });
      writeFileSync(path.join(dailyDir, "2026-03-15-saturday.md"), "hello world");

      const files = [path.join(dailyDir, "2026-03-15-saturday.md")];
      const entries = collectJournalEntries(files, tmpDir);

      expect(entries).toHaveLength(1);
      expect(entries[0].relativePath).toBe(path.join("daily-notes", "2026-03-15-saturday.md"));
      expect(entries[0].type).toBe(JOURNAL_TYPES.DAILY_NOTES);
      expect(entries[0].date).not.toBeNull();
      expect(entries[0].date!.getFullYear()).toBe(2026);
      expect(entries[0].size).toBeGreaterThan(0);
    });

    it("skips files that cannot be stat'd", () => {
      const entries = collectJournalEntries(["/nonexistent/file.md"], tmpDir);
      expect(entries).toHaveLength(0);
    });
  });

  describe("filterAndSortEntries", () => {
    const makeEntry = (overrides: Partial<JournalEntry>): JournalEntry => ({
      filePath: "/tmp/file.md",
      relativePath: "file.md",
      type: null,
      date: null,
      size: 100,
      ...overrides,
    });

    it("filters by type", () => {
      const entries = [
        makeEntry({ type: JOURNAL_TYPES.DAILY_NOTES, relativePath: "a.md" }),
        makeEntry({ type: JOURNAL_TYPES.MEETING, relativePath: "b.md" }),
        makeEntry({ type: JOURNAL_TYPES.NOTE, relativePath: "c.md" }),
      ];

      const result = filterAndSortEntries(entries, {
        type: JOURNAL_TYPES.MEETING,
        limit: 20,
        sort: "date",
      });
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe(JOURNAL_TYPES.MEETING);
    });

    it("sorts by date descending", () => {
      const entries = [
        makeEntry({ date: new Date(2026, 0, 1), relativePath: "jan.md" }),
        makeEntry({ date: new Date(2026, 2, 15), relativePath: "mar.md" }),
        makeEntry({ date: new Date(2026, 1, 10), relativePath: "feb.md" }),
      ];

      const result = filterAndSortEntries(entries, { limit: 20, sort: "date" });
      expect(result[0].relativePath).toBe("mar.md");
      expect(result[1].relativePath).toBe("feb.md");
      expect(result[2].relativePath).toBe("jan.md");
    });

    it("sorts by name alphabetically", () => {
      const entries = [
        makeEntry({ relativePath: "c.md" }),
        makeEntry({ relativePath: "a.md" }),
        makeEntry({ relativePath: "b.md" }),
      ];

      const result = filterAndSortEntries(entries, { limit: 20, sort: "name" });
      expect(result[0].relativePath).toBe("a.md");
      expect(result[1].relativePath).toBe("b.md");
      expect(result[2].relativePath).toBe("c.md");
    });

    it("respects limit", () => {
      const entries = [
        makeEntry({ relativePath: "a.md" }),
        makeEntry({ relativePath: "b.md" }),
        makeEntry({ relativePath: "c.md" }),
      ];

      const result = filterAndSortEntries(entries, { limit: 2, sort: "name" });
      expect(result).toHaveLength(2);
    });

    it("puts entries without dates last when sorting by date", () => {
      const entries = [
        makeEntry({ date: null, relativePath: "no-date.md" }),
        makeEntry({ date: new Date(2026, 5, 1), relativePath: "with-date.md" }),
      ];

      const result = filterAndSortEntries(entries, { limit: 20, sort: "date" });
      expect(result[0].relativePath).toBe("with-date.md");
      expect(result[1].relativePath).toBe("no-date.md");
    });
  });

  describe("formatSize", () => {
    it("formats bytes", () => {
      expect(formatSize(500)).toBe("500B");
    });

    it("formats kilobytes", () => {
      expect(formatSize(2048)).toBe("2.0KB");
    });

    it("formats megabytes", () => {
      expect(formatSize(1048576)).toBe("1.0MB");
    });
  });

  describe("formatDate", () => {
    it("formats a valid date", () => {
      expect(formatDate(new Date(2026, 2, 15))).toBe("2026-03-15");
    });

    it("returns dash for null", () => {
      expect(formatDate(null)).toBe("-");
    });
  });

  describe("renderTable", () => {
    it("renders a formatted table with header and rows", () => {
      const entries: JournalEntry[] = [
        {
          filePath: "/tmp/daily-notes/2026-03-15.md",
          relativePath: "daily-notes/2026-03-15.md",
          type: JOURNAL_TYPES.DAILY_NOTES,
          date: new Date(2026, 2, 15),
          size: 1234,
        },
      ];

      const table = renderTable(entries);
      const lines = table.split("\n");
      expect(lines).toHaveLength(2); // header + 1 row
      expect(lines[0]).toContain("FILE");
      expect(lines[0]).toContain("TYPE");
      expect(lines[0]).toContain("DATE");
      expect(lines[0]).toContain("SIZE");
      expect(lines[1]).toContain("daily-notes/2026-03-15.md");
      expect(lines[1]).toContain("daily-notes");
      expect(lines[1]).toContain("2026-03-15");
      expect(lines[1]).toContain("1.2KB");
    });
  });
});
