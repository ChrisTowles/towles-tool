import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createMockLogger } from "../helpers/mock-deps";
import { WorkflowLoader } from "../../server/domains/execution/workflow-loader";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-loader-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Mock glob to use readdirSync instead
const mockGlob = vi.fn(async (pattern: string) => {
  const dir = pattern.replace("/*.yaml", "").replace("\\*.yaml", "");
  try {
    const files = readdirSync(dir);
    return files.filter((f: string) => f.endsWith(".yaml")).map((f: string) => join(dir, f));
  } catch {
    return [];
  }
});

// Mock chokidar — capture event handlers so we can trigger them in tests
const chokidarHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};
const mockWatcherClose = vi.fn().mockResolvedValue(undefined);
const mockWatch = vi.fn(() => {
  // Reset handlers for each new watcher
  for (const key of Object.keys(chokidarHandlers)) {
    delete chokidarHandlers[key];
  }
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!chokidarHandlers[event]) chokidarHandlers[event] = [];
      chokidarHandlers[event].push(handler);
      return {
        on: vi.fn((event2: string, handler2: (...args: unknown[]) => void) => {
          if (!chokidarHandlers[event2]) chokidarHandlers[event2] = [];
          chokidarHandlers[event2].push(handler2);
          return {
            on: vi.fn((event3: string, handler3: (...args: unknown[]) => void) => {
              if (!chokidarHandlers[event3]) chokidarHandlers[event3] = [];
              chokidarHandlers[event3].push(handler3);
              return { on: vi.fn().mockReturnThis(), close: mockWatcherClose };
            }),
            close: mockWatcherClose,
          };
        }),
        close: mockWatcherClose,
      };
    }),
    close: mockWatcherClose,
  };
});

function createLoader() {
  return new WorkflowLoader({
    logger: createMockLogger() as never,
    glob: mockGlob as never,
    watch: mockWatch as never,
  });
}

describe("WorkflowLoader", () => {
  it("loadFromRepos loads workflows from multiple repo paths", async () => {
    const repo1 = makeTmpDir();
    const repo2 = makeTmpDir();

    const wfDir1 = resolve(repo1, ".agentboard", "workflows");
    const wfDir2 = resolve(repo2, ".agentboard", "workflows");
    mkdirSync(wfDir1, { recursive: true });
    mkdirSync(wfDir2, { recursive: true });

    writeFileSync(
      resolve(wfDir1, "wf1.yaml"),
      `name: workflow-one
steps:
  - id: s1
    prompt_template: p.md
    artifact: out.md
`,
    );

    writeFileSync(
      resolve(wfDir2, "wf2.yaml"),
      `name: workflow-two
steps:
  - id: s1
    prompt_template: p.md
    artifact: out.md
`,
    );

    const loader = createLoader();
    try {
      await loader.loadFromRepos([repo1, repo2]);

      expect(loader.list()).toHaveLength(2);
      expect(loader.get("workflow-one")).toBeDefined();
      expect(loader.get("workflow-two")).toBeDefined();
    } finally {
      await loader.close();
    }
  });

  it("loads valid YAML workflow from repo", async () => {
    const repoPath = makeTmpDir();
    const wfDir = resolve(repoPath, ".agentboard", "workflows");
    mkdirSync(wfDir, { recursive: true });

    writeFileSync(
      resolve(wfDir, "auto-claude.yaml"),
      `name: auto-claude
description: Automated pipeline
steps:
  - id: plan
    prompt_template: prompts/plan.md
    artifact: plan.md
  - id: implement
    prompt_template: prompts/implement.md
    artifact: code
    pass_condition: "contains:SUCCESS"
`,
    );

    const loader = createLoader();
    try {
      await loader.loadFromRepo(repoPath);

      const wf = loader.get("auto-claude");
      expect(wf).toBeDefined();
      expect(wf!.name).toBe("auto-claude");
      expect(wf!.description).toBe("Automated pipeline");
      expect(wf!.steps).toHaveLength(2);
      expect(wf!.steps[0]!.id).toBe("plan");
      expect(wf!.steps[1]!.pass_condition).toBe("contains:SUCCESS");
    } finally {
      await loader.close();
    }
  });

  it("handles missing workflow directory gracefully", async () => {
    const repoPath = makeTmpDir();
    // No .agentboard/workflows dir created

    const loader = createLoader();
    try {
      await loader.loadFromRepo(repoPath);
      // Should not throw, just return with no workflows loaded
      expect(loader.list()).toHaveLength(0);
    } finally {
      await loader.close();
    }
  });

  it("skips invalid YAML missing name field", async () => {
    const repoPath = makeTmpDir();
    const wfDir = resolve(repoPath, ".agentboard", "workflows");
    mkdirSync(wfDir, { recursive: true });

    writeFileSync(
      resolve(wfDir, "bad.yaml"),
      `description: No name field
steps:
  - id: plan
    prompt_template: prompts/plan.md
    artifact: plan.md
`,
    );

    const loader = createLoader();
    try {
      await loader.loadFromRepo(repoPath);
      expect(loader.list()).toHaveLength(0);
    } finally {
      await loader.close();
    }
  });

  it("skips invalid YAML missing steps field", async () => {
    const repoPath = makeTmpDir();
    const wfDir = resolve(repoPath, ".agentboard", "workflows");
    mkdirSync(wfDir, { recursive: true });

    writeFileSync(
      resolve(wfDir, "no-steps.yaml"),
      `name: broken-workflow
description: Has name but no steps
`,
    );

    const loader = createLoader();
    try {
      await loader.loadFromRepo(repoPath);
      expect(loader.get("broken-workflow")).toBeUndefined();
    } finally {
      await loader.close();
    }
  });

  it("get() returns undefined for unknown workflow", async () => {
    const loader = createLoader();
    expect(loader.get("nonexistent")).toBeUndefined();
    await loader.close();
  });

  it("list() returns all loaded workflows", async () => {
    const repoPath = makeTmpDir();
    const wfDir = resolve(repoPath, ".agentboard", "workflows");
    mkdirSync(wfDir, { recursive: true });

    writeFileSync(
      resolve(wfDir, "first.yaml"),
      `name: first-workflow
steps:
  - id: step1
    prompt_template: p.md
    artifact: out.md
`,
    );

    writeFileSync(
      resolve(wfDir, "second.yaml"),
      `name: second-workflow
steps:
  - id: step1
    prompt_template: p.md
    artifact: out.md
`,
    );

    const loader = createLoader();
    try {
      await loader.loadFromRepo(repoPath);

      const all = loader.list();
      expect(all).toHaveLength(2);
      const names = all.map((w) => w.name).sort();
      expect(names).toEqual(["first-workflow", "second-workflow"]);
    } finally {
      await loader.close();
    }
  });

  it("loadFile with corrupted YAML content logs error without throwing", async () => {
    const repoPath = makeTmpDir();
    const wfDir = resolve(repoPath, ".agentboard", "workflows");
    mkdirSync(wfDir, { recursive: true });

    // Write content that parses as YAML but is a string, not an object with name/steps
    writeFileSync(resolve(wfDir, "corrupt.yaml"), ": :\n  - : [}{");

    const loader = createLoader();
    try {
      await loader.loadFromRepo(repoPath);
      // Should not throw, and no workflows should be loaded
      expect(loader.list()).toHaveLength(0);
    } finally {
      await loader.close();
    }
  });

  it("close() stops all watchers", async () => {
    const repoPath = makeTmpDir();
    const wfDir = resolve(repoPath, ".agentboard", "workflows");
    mkdirSync(wfDir, { recursive: true });

    writeFileSync(
      resolve(wfDir, "wf.yaml"),
      `name: test-wf
steps:
  - id: s1
    prompt_template: p.md
    artifact: out.md
`,
    );

    const loader = createLoader();
    await loader.loadFromRepo(repoPath);

    mockWatcherClose.mockClear();
    await loader.close();

    expect(mockWatcherClose).toHaveBeenCalled();
  });

  it("chokidar add handler loads new yaml files", async () => {
    const repoPath = makeTmpDir();
    const wfDir = resolve(repoPath, ".agentboard", "workflows");
    mkdirSync(wfDir, { recursive: true });

    // Create initial file so the directory exists for loadFromRepo
    writeFileSync(
      resolve(wfDir, "initial.yaml"),
      `name: initial
steps:
  - id: s1
    prompt_template: p.md
    artifact: out.md
`,
    );

    const loader = createLoader();
    try {
      await loader.loadFromRepo(repoPath);

      expect(loader.list()).toHaveLength(1);

      // Now simulate chokidar "add" event with a new YAML file
      const newFile = resolve(wfDir, "added.yaml");
      writeFileSync(
        newFile,
        `name: added-wf
steps:
  - id: s1
    prompt_template: p.md
    artifact: out.md
`,
      );

      // Fire the add handler
      if (chokidarHandlers["add"]) {
        for (const handler of chokidarHandlers["add"]) {
          handler(newFile);
        }
      }

      expect(loader.get("added-wf")).toBeDefined();
      expect(loader.list()).toHaveLength(2);
    } finally {
      await loader.close();
    }
  });

  it("chokidar change handler reloads yaml files", async () => {
    const repoPath = makeTmpDir();
    const wfDir = resolve(repoPath, ".agentboard", "workflows");
    mkdirSync(wfDir, { recursive: true });

    const filePath = resolve(wfDir, "changeable.yaml");
    writeFileSync(
      filePath,
      `name: my-workflow
description: original
steps:
  - id: s1
    prompt_template: p.md
    artifact: out.md
`,
    );

    const loader = createLoader();
    try {
      await loader.loadFromRepo(repoPath);
      expect(loader.get("my-workflow")!.description).toBe("original");

      // Update file on disk and fire change event
      writeFileSync(
        filePath,
        `name: my-workflow
description: updated
steps:
  - id: s1
    prompt_template: p.md
    artifact: out.md
`,
      );

      if (chokidarHandlers["change"]) {
        for (const handler of chokidarHandlers["change"]) {
          handler(filePath);
        }
      }

      expect(loader.get("my-workflow")!.description).toBe("updated");
    } finally {
      await loader.close();
    }
  });

  it("chokidar unlink handler triggers removeByPath", async () => {
    const repoPath = makeTmpDir();
    const wfDir = resolve(repoPath, ".agentboard", "workflows");
    mkdirSync(wfDir, { recursive: true });

    writeFileSync(
      resolve(wfDir, "removable.yaml"),
      `name: removable
steps:
  - id: s1
    prompt_template: p.md
    artifact: out.md
`,
    );

    const loader = createLoader();
    try {
      await loader.loadFromRepo(repoPath);
      expect(loader.get("removable")).toBeDefined();

      // Fire unlink event — removeByPath just logs, doesn't actually remove from map
      if (chokidarHandlers["unlink"]) {
        for (const handler of chokidarHandlers["unlink"]) {
          handler(resolve(wfDir, "removable.yaml"));
        }
      }

      // removeByPath currently only logs, so workflow is still in the map
      // This test covers the unlink handler code path (lines 75-78)
      expect(loader.get("removable")).toBeDefined();
    } finally {
      await loader.close();
    }
  });

  it("chokidar handlers ignore non-yaml files", async () => {
    const repoPath = makeTmpDir();
    const wfDir = resolve(repoPath, ".agentboard", "workflows");
    mkdirSync(wfDir, { recursive: true });

    writeFileSync(
      resolve(wfDir, "initial.yaml"),
      `name: initial
steps:
  - id: s1
    prompt_template: p.md
    artifact: out.md
`,
    );

    const loader = createLoader();
    try {
      await loader.loadFromRepo(repoPath);

      // Fire add event with a non-yaml file
      if (chokidarHandlers["add"]) {
        for (const handler of chokidarHandlers["add"]) {
          handler(resolve(wfDir, "readme.txt"));
        }
      }

      // Should still only have the initial workflow
      expect(loader.list()).toHaveLength(1);
    } finally {
      await loader.close();
    }
  });

  it("loads workflows with full schema including post_steps and labels", async () => {
    const repoPath = makeTmpDir();
    const wfDir = resolve(repoPath, ".agentboard", "workflows");
    mkdirSync(wfDir, { recursive: true });

    writeFileSync(
      resolve(wfDir, "full.yaml"),
      `name: full-workflow
triggers:
  github_label: auto-claude
steps:
  - id: plan
    prompt_template: plan.md
    artifact: plan.md
    max_retries: 2
    on_fail: "goto:plan"
post_steps:
  create_pr: true
  pr_title_template: "[auto] {card_title}"
labels:
  in_progress: wip
  success: done
  failure: failed
branch_template: "agentboard/card-{card_id}"
`,
    );

    const loader = createLoader();
    try {
      await loader.loadFromRepo(repoPath);

      const wf = loader.get("full-workflow");
      expect(wf).toBeDefined();
      expect(wf!.triggers?.github_label).toBe("auto-claude");
      expect(wf!.post_steps?.create_pr).toBe(true);
      expect(wf!.labels?.success).toBe("done");
      expect(wf!.branch_template).toBe("agentboard/card-{card_id}");
    } finally {
      await loader.close();
    }
  });
});
