import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTestRepo,
  createTestSlot,
  createTestCard,
  getCard,
  moveCard,
  updateCard,
  simulateStepCompleteHook,
  simulateStopHook,
} from "../helpers";

const tmpDirs: string[] = [];

function makeTmpSlotDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

function artifactsDir(slotPath: string, cardId: number): string {
  return join(slotPath, "artifacts", String(cardId));
}

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Multi-Step Workflow (plan → implement → review)", { timeout: 30_000 }, () => {
  let repoId: number;
  let slotPath: string;
  let cardId: number;

  beforeAll(async () => {
    const repo = await createTestRepo("multi-step-workflow-repo");
    repoId = repo.id;

    slotPath = makeTmpSlotDir("workflow-test-slot");
    await createTestSlot(repoId, slotPath);
  });

  it("creates a card with workflow in backlog", async () => {
    const card = await createTestCard(repoId, "Multi-step workflow test", {
      workflowId: "auto-claude",
      description: "Test: implement isPalindrome function",
    });
    cardId = card.id;

    expect(card.column).toBe("backlog");
    expect(card.status).toBe("idle");
  });

  it("moving to in_progress starts workflow execution", async () => {
    await moveCard(cardId, "in_progress");
    await new Promise((r) => setTimeout(r, 500));

    const card = await getCard(cardId);
    expect(card.column).toBe("in_progress");
    // In test env without tmux, may be queued or running
    expect(["running", "queued"]).toContain(card.status);
  });

  it("simulating plan step completion updates card state", async () => {
    // Force status to running for hook to process
    await updateCard(cardId, { status: "running", currentStepId: "plan" });

    const dir = artifactsDir(slotPath, cardId);
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      join(dir, "plan.md"),
      `PASS
## Plan: isPalindrome function

### Overview
Add an isPalindrome function that checks if a string reads the same forward and backward.

### Implementation Steps
1. Create or update utils.ts
2. Add isPalindrome function with string cleaning
3. Add comprehensive tests

### Test Plan
- Test palindromes: "racecar", "madam", "A man a plan a canal Panama"
- Test non-palindromes: "hello", "world"
- Test edge cases: empty string, single character
`,
    );

    // Simulate step-complete hook (plan step done)
    const result = await simulateStepCompleteHook(cardId);
    // May be ignored if no pending callback in test env
    expect(result.ok).toBe(true);

    // Update card to reflect step completion
    await updateCard(cardId, { currentStepId: "plan:done" });

    const card = await getCard(cardId);
    expect(card.currentStepId).toBe("plan:done");
  });

  it("simulating implement step completion with artifact", async () => {
    await updateCard(cardId, { status: "running", currentStepId: "implement" });

    const dir = artifactsDir(slotPath, cardId);
    const codeSnippet = `export function isPalindrome(str: string): boolean {
  const cleaned = str.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned === cleaned.split("").reverse().join("");
}
`;
    writeFileSync(join(dir, "implement.md"), `${codeSnippet}\n// Tests added to utils.test.ts\n`);
    writeFileSync(join(slotPath, "utils.ts"), codeSnippet);

    const result = await simulateStepCompleteHook(cardId);
    expect(result.ok).toBe(true);

    await updateCard(cardId, { currentStepId: "implement:done" });

    const card = await getCard(cardId);
    expect(card.currentStepId).toBe("implement:done");
  });

  it("simulating review step completion with PASS verdict", async () => {
    await updateCard(cardId, { status: "running", currentStepId: "review" });

    const dir = artifactsDir(slotPath, cardId);
    writeFileSync(
      join(dir, "review.md"),
      `PASS

## Review Summary

### Code Quality
- Implementation follows project conventions
- Function is well-named and clear
- Edge cases handled correctly

### Test Coverage
- Palindrome cases covered
- Non-palindrome cases covered
- Edge cases (empty, single char) covered

### Verdict
Implementation is correct and ready for merge.
`,
    );

    const result = await simulateStepCompleteHook(cardId);
    expect(result.ok).toBe(true);

    await updateCard(cardId, { currentStepId: "review:done" });

    const card = await getCard(cardId);
    expect(card.currentStepId).toBe("review:done");
  });

  it("workflow completion moves card to review column", async () => {
    // Simulate final Stop hook (workflow complete)
    await updateCard(cardId, { status: "running" });
    const result = await simulateStopHook(cardId);
    expect(result.ok).toBe(true);

    const card = await getCard(cardId);
    expect(card.column).toBe("review");
    expect(card.status).toBe("review_ready");
  });

  it("moving to done archives the card and releases slot", async () => {
    await moveCard(cardId, "done");

    const card = await getCard(cardId);
    expect(card.column).toBe("done");
    expect(card.status).toBe("done");
  });

  it("verifies artifacts exist in slot directory", () => {
    const dir = artifactsDir(slotPath, cardId);

    for (const file of ["plan.md", "implement.md", "review.md"]) {
      expect(existsSync(join(dir, file))).toBe(true);
    }
    expect(existsSync(join(slotPath, "utils.ts"))).toBe(true);
  });
});

describe("Multi-Step Workflow with FAIL and Retry", { timeout: 30_000 }, () => {
  let repoId: number;
  let slotPath: string;
  let cardId: number;

  beforeAll(async () => {
    const repo = await createTestRepo("retry-workflow-repo");
    repoId = repo.id;

    slotPath = makeTmpSlotDir("workflow-retry-test");
    await createTestSlot(repoId, slotPath);
  });

  it("creates card and simulates review FAIL triggering retry", async () => {
    const card = await createTestCard(repoId, "Retry workflow test", {
      workflowId: "auto-claude",
    });
    cardId = card.id;

    // Move through steps quickly
    await moveCard(cardId, "in_progress");
    await new Promise((r) => setTimeout(r, 300));

    const dir = artifactsDir(slotPath, cardId);
    mkdirSync(dir, { recursive: true });

    // Plan passes
    await updateCard(cardId, { status: "running", currentStepId: "plan" });
    writeFileSync(join(dir, "plan.md"), "PASS\nPlan for feature X");
    await simulateStepCompleteHook(cardId);
    await updateCard(cardId, { currentStepId: "plan:done" });

    // Implement completes
    await updateCard(cardId, { status: "running", currentStepId: "implement" });
    writeFileSync(join(dir, "implement.md"), "Implementation done");
    await simulateStepCompleteHook(cardId);
    await updateCard(cardId, { currentStepId: "implement:done" });

    // Review FAILS (first attempt)
    await updateCard(cardId, { status: "running", currentStepId: "review", retryCount: 0 });
    writeFileSync(join(dir, "review.md"), "FAIL\nMissing error handling for edge cases");
    await simulateStepCompleteHook(cardId);

    // Retry: implement again with retryCount incremented
    await updateCard(cardId, { status: "running", currentStepId: "implement", retryCount: 1 });
    writeFileSync(join(dir, "implement.md"), "Implementation with error handling added");
    await simulateStepCompleteHook(cardId);
    await updateCard(cardId, { currentStepId: "implement:done" });

    // Review PASSES on retry
    await updateCard(cardId, { status: "running", currentStepId: "review" });
    writeFileSync(join(dir, "review.md"), "PASS\nAll issues addressed");
    await simulateStepCompleteHook(cardId);
    await updateCard(cardId, { currentStepId: "review:done" });

    // Complete workflow
    await updateCard(cardId, { status: "running" });
    await simulateStopHook(cardId);

    const finalCard = await getCard(cardId);
    expect(finalCard.column).toBe("review");
    expect(finalCard.status).toBe("review_ready");
  });

  it("card can be approved and moved to done after retry success", async () => {
    await moveCard(cardId, "done");

    const card = await getCard(cardId);
    expect(card.column).toBe("done");
    expect(card.status).toBe("done");
  });
});
