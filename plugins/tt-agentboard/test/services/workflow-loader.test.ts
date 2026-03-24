import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

// Mock glob to use readdirSync instead (glob package not installed)
vi.mock("glob", () => ({
  glob: vi.fn(async (pattern: string) => {
    // Extract directory from pattern like "/tmp/.../workflows/*.yaml"
    const dir = pattern.replace("/*.yaml", "").replace("\\*.yaml", "");
    try {
      const files = readdirSync(dir);
      return files.filter((f: string) => f.endsWith(".yaml")).map((f: string) => join(dir, f));
    } catch {
      return [];
    }
  }),
}));

// Mock chokidar to avoid file watching in tests
vi.mock("chokidar", () => ({
  watch: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// eslint-disable-next-line import/first -- vi.mock must come before imports
import { WorkflowLoader } from "../../server/services/workflow-loader";

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

describe("WorkflowLoader", () => {
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

    const loader = new WorkflowLoader();
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

    const loader = new WorkflowLoader();
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

    const loader = new WorkflowLoader();
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

    const loader = new WorkflowLoader();
    try {
      await loader.loadFromRepo(repoPath);
      expect(loader.get("broken-workflow")).toBeUndefined();
    } finally {
      await loader.close();
    }
  });

  it("get() returns undefined for unknown workflow", async () => {
    const loader = new WorkflowLoader();
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

    const loader = new WorkflowLoader();
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

    const loader = new WorkflowLoader();
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
