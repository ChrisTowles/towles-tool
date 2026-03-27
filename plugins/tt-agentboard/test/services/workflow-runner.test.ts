import { describe, it, expect } from "vitest";
import {
  checkPassCondition,
  renderTemplate,
  shellEscape,
} from "../../server/domains/execution/workflow-helpers";

describe("workflow-helpers", () => {
  describe("checkPassCondition()", () => {
    it("first_line_equals matches when first line equals expected", () => {
      expect(checkPassCondition("first_line_equals:PASS", "PASS\ndetails")).toBe(true);
    });

    it("first_line_equals fails when first line differs", () => {
      expect(checkPassCondition("first_line_equals:PASS", "FAIL\ndetails")).toBe(false);
    });

    it("first_line_equals trims whitespace from first line", () => {
      expect(checkPassCondition("first_line_equals:PASS", "  PASS  \ndetails")).toBe(true);
    });

    it("first_line_equals handles empty content", () => {
      expect(checkPassCondition("first_line_equals:PASS", "")).toBe(false);
    });

    it("contains returns true when content includes substring", () => {
      expect(checkPassCondition("contains:SUCCESS", "the run was a SUCCESS")).toBe(true);
    });

    it("contains returns false when content missing substring", () => {
      expect(checkPassCondition("contains:SUCCESS", "it failed")).toBe(false);
    });

    it("contains is case-sensitive", () => {
      expect(checkPassCondition("contains:SUCCESS", "success")).toBe(false);
    });

    it("unknown format defaults to true", () => {
      expect(checkPassCondition("unknown:format", "anything")).toBe(true);
    });

    it("completely unknown condition defaults to true", () => {
      expect(checkPassCondition("regex:.*", "anything")).toBe(true);
    });
  });

  describe("renderTemplate()", () => {
    it("replaces single variable", () => {
      expect(renderTemplate("{card_id}", { card_id: "42" })).toBe("42");
    });

    it("replaces multiple variables", () => {
      expect(renderTemplate("{card_title} - {issue}", { card_title: "Fix bug", issue: "42" })).toBe(
        "Fix bug - 42",
      );
    });

    it("replaces all occurrences of same variable", () => {
      expect(renderTemplate("{id}-{id}", { id: "1" })).toBe("1-1");
    });

    it("leaves unmatched placeholders as-is", () => {
      expect(renderTemplate("{card_id}-{unknown}", { card_id: "1" })).toBe("1-{unknown}");
    });

    it("handles empty vars", () => {
      expect(renderTemplate("static text", {})).toBe("static text");
    });

    it("handles empty value", () => {
      expect(renderTemplate("issue-{issue}", { issue: "" })).toBe("issue-");
    });
  });

  describe("shellEscape()", () => {
    it("wraps in single quotes", () => {
      expect(shellEscape("hello")).toBe("'hello'");
    });

    it("escapes single quotes within string", () => {
      expect(shellEscape("it's")).toBe("'it'\\''s'");
    });

    it("handles empty string", () => {
      expect(shellEscape("")).toBe("''");
    });

    it("handles multiple single quotes", () => {
      expect(shellEscape("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
    });

    it("does not escape double quotes", () => {
      expect(shellEscape('say "hi"')).toBe("'say \"hi\"'");
    });
  });
});
