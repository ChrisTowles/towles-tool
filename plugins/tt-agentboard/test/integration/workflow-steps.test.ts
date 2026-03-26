import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { checkPassCondition, renderTemplate } from "../../server/utils/workflow-helpers";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "workflow-steps-test-"));
  tmpDirs.push(dir);
  return dir;
}

function isClaudeAvailable(): boolean {
  try {
    execSync("which claude", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Workflow Steps Integration", { timeout: 120_000 }, () => {
  describe("checkPassCondition with real artifact content", () => {
    it("validates a plan artifact with first_line_equals", () => {
      const planContent = `PASS
## Plan: isPalindrome function

### Steps
1. Create utils.ts
2. Add isPalindrome function
3. Add tests
`;
      expect(checkPassCondition("first_line_equals:PASS", planContent)).toBe(true);
    });

    it("validates a plan artifact with contains", () => {
      const planContent = `# Plan

## Implementation
Add an isPalindrome function that checks if a string reads the same forward and backward.

## Test Plan
- Test with palindromes: "racecar", "madam"
- Test with non-palindromes: "hello"
- Test edge cases: empty string, single char
`;
      expect(checkPassCondition("contains:isPalindrome", planContent)).toBe(true);
      expect(checkPassCondition("contains:Test Plan", planContent)).toBe(true);
      expect(checkPassCondition("contains:nonexistent_function", planContent)).toBe(false);
    });

    it("validates renderTemplate for step artifact paths", () => {
      const artifactPath = renderTemplate("artifacts/{card_id}/{step_id}.md", {
        card_id: "42",
        step_id: "plan",
      });
      expect(artifactPath).toBe("artifacts/42/plan.md");
    });

    it("handles multi-step artifact chain validation", () => {
      // Simulates checking output from each step of a workflow
      const planArtifact = "PASS\nCreate isPalindrome in utils.ts";
      const implementArtifact = `export function isPalindrome(str: string): boolean {
  const cleaned = str.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned === cleaned.split("").reverse().join("");
}
`;
      const reviewArtifact = "PASS\nImplementation looks correct and follows conventions.";

      expect(checkPassCondition("first_line_equals:PASS", planArtifact)).toBe(true);
      expect(checkPassCondition("contains:isPalindrome", implementArtifact)).toBe(true);
      expect(checkPassCondition("first_line_equals:PASS", reviewArtifact)).toBe(true);
    });
  });

  describe("live Claude plan + implement", () => {
    it("creates a plan file when prompted", async ({ skip }) => {
      if (!isClaudeAvailable()) skip();

      const dir = makeTmpDir();

      // Initialize git repo
      execSync("git init", { cwd: dir, stdio: "ignore" });
      execSync("git config user.email 'test@test.com'", { cwd: dir, stdio: "ignore" });
      execSync("git config user.name 'Test'", { cwd: dir, stdio: "ignore" });

      // Seed with an empty utils.ts
      writeFileSync(join(dir, "utils.ts"), "// Utils\n");
      execSync("git add -A && git commit -m 'initial'", { cwd: dir, stdio: "ignore" });

      // Step 1: Plan
      const planPrompt =
        "Write a plan for adding an isPalindrome function to utils.ts. Output your plan to plan.md. Include sections: Overview, Implementation Steps, and Test Plan.";
      execSync(
        `claude --model haiku -p "${planPrompt}" --max-turns 5 --dangerously-skip-permissions`,
        { cwd: dir, stdio: "ignore", timeout: 60_000 },
      );

      expect(existsSync(join(dir, "plan.md"))).toBe(true);
      const planContent = readFileSync(join(dir, "plan.md"), "utf-8");
      expect(planContent.length).toBeGreaterThan(10);
      expect(planContent.toLowerCase()).toContain("palindrome");

      // Step 2: Implement
      const implementPrompt =
        "Read plan.md and implement the isPalindrome function in utils.ts as described. Export the function. Commit your changes.";
      execSync(
        `claude --model haiku -p "${implementPrompt}" --max-turns 5 --dangerously-skip-permissions`,
        { cwd: dir, stdio: "ignore", timeout: 60_000 },
      );

      const utilsContent = readFileSync(join(dir, "utils.ts"), "utf-8");
      expect(utilsContent).toContain("isPalindrome");

      // Validate the artifact with checkPassCondition
      expect(checkPassCondition("contains:isPalindrome", utilsContent)).toBe(true);
    });
  });
});
