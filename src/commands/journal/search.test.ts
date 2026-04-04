import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  collectMarkdownFiles,
  inferTypeFromPath,
  extractDateFromFilename,
  searchJournalFiles,
  parseDateRange,
} from "./search.js";
import { JOURNAL_TYPES } from "../../types/journal.js";

describe("journal search", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(tmpdir(), `journal-search-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("collectMarkdownFiles", () => {
    it("collects .md files recursively", () => {
      mkdirSync(path.join(tmpDir, "sub"), { recursive: true });
      writeFileSync(path.join(tmpDir, "a.md"), "hello");
      writeFileSync(path.join(tmpDir, "b.txt"), "ignored");
      writeFileSync(path.join(tmpDir, "sub", "c.md"), "nested");

      const files = collectMarkdownFiles(tmpDir);
      expect(files).toHaveLength(2);
      expect(files.some((f) => f.endsWith("a.md"))).toBe(true);
      expect(files.some((f) => f.endsWith("c.md"))).toBe(true);
    });

    it("returns empty for nonexistent directory", () => {
      expect(collectMarkdownFiles("/nonexistent-dir-12345")).toEqual([]);
    });
  });

  describe("inferTypeFromPath", () => {
    it("detects daily-notes", () => {
      expect(inferTypeFromPath("/journal/2026/01/daily-notes/file.md")).toBe(
        JOURNAL_TYPES.DAILY_NOTES,
      );
    });

    it("detects meeting", () => {
      expect(inferTypeFromPath("/journal/2026/01/meetings/standup.md")).toBe(JOURNAL_TYPES.MEETING);
    });

    it("detects note", () => {
      expect(inferTypeFromPath("/journal/2026/01/notes/idea.md")).toBe(JOURNAL_TYPES.NOTE);
    });

    it("returns null for unknown", () => {
      expect(inferTypeFromPath("/journal/2026/01/other/file.md")).toBeNull();
    });
  });

  describe("extractDateFromFilename", () => {
    it("extracts date from standard filename", () => {
      const date = extractDateFromFilename("/path/2026-03-15-standup.md");
      expect(date).not.toBeNull();
      expect(date!.getFullYear()).toBe(2026);
      expect(date!.getMonth()).toBe(2); // 0-indexed
      expect(date!.getDate()).toBe(15);
    });

    it("returns null when no date pattern", () => {
      expect(extractDateFromFilename("/path/readme.md")).toBeNull();
    });
  });

  describe("searchJournalFiles", () => {
    it("finds matching lines with context", () => {
      const file = path.join(tmpDir, "2026-01-10-test.md");
      writeFileSync(file, "line one\nline two\nfind me here\nline four\nline five");

      const matches = searchJournalFiles([file], { query: "find me" });
      expect(matches).toHaveLength(1);
      expect(matches[0].lineNumber).toBe(3);
      expect(matches[0].line).toBe("find me here");
      expect(matches[0].context).toHaveLength(5); // 2 before + match + 2 after
    });

    it("is case-insensitive", () => {
      const file = path.join(tmpDir, "2026-01-10-test.md");
      writeFileSync(file, "Hello World\nfoo bar");

      const matches = searchJournalFiles([file], { query: "hello" });
      expect(matches).toHaveLength(1);
    });

    it("filters by type", () => {
      const dailyDir = path.join(tmpDir, "daily-notes");
      const notesDir = path.join(tmpDir, "notes");
      mkdirSync(dailyDir, { recursive: true });
      mkdirSync(notesDir, { recursive: true });

      const dailyFile = path.join(dailyDir, "2026-01-10-daily.md");
      const noteFile = path.join(notesDir, "2026-01-10-idea.md");
      writeFileSync(dailyFile, "keyword here");
      writeFileSync(noteFile, "keyword here too");

      const matches = searchJournalFiles([dailyFile, noteFile], {
        query: "keyword",
        type: JOURNAL_TYPES.DAILY_NOTES,
      });
      expect(matches).toHaveLength(1);
      expect(matches[0].filePath).toBe(dailyFile);
    });

    it("filters by date range", () => {
      const oldFile = path.join(tmpDir, "2025-06-01-old.md");
      const newFile = path.join(tmpDir, "2026-02-15-new.md");
      writeFileSync(oldFile, "keyword");
      writeFileSync(newFile, "keyword");

      const matches = searchJournalFiles([oldFile, newFile], {
        query: "keyword",
        startDate: new Date(2026, 0, 1),
        endDate: new Date(2026, 11, 31),
      });
      expect(matches).toHaveLength(1);
      expect(matches[0].filePath).toBe(newFile);
    });

    it("returns empty when no matches", () => {
      const file = path.join(tmpDir, "2026-01-10-test.md");
      writeFileSync(file, "nothing relevant");

      const matches = searchJournalFiles([file], { query: "xyznotfound" });
      expect(matches).toHaveLength(0);
    });
  });

  describe("parseDateRange", () => {
    it("parses valid range", () => {
      const { startDate, endDate } = parseDateRange("2026-01-01..2026-03-01");
      expect(startDate.getFullYear()).toBe(2026);
      expect(endDate.getMonth()).toBe(2); // March = 2 (0-indexed)
    });

    it("throws on invalid format", () => {
      expect(() => parseDateRange("invalid")).toThrow("Invalid date range format");
    });

    it("throws TypeError on invalid dates", () => {
      expect(() => parseDateRange("notadate..alsonot")).toThrow(TypeError);
    });
  });
});
