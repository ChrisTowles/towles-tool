import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { watch } from "chokidar";
import { logger } from "../utils/logger";

/** Default glob implementation using readdirSync (avoids 'glob' package dependency) */
async function defaultGlob(pattern: string): Promise<string[]> {
  const dir = pattern.replace(/[/\\]\*\.yaml$/, "");
  try {
    const files = readdirSync(dir);
    return files.filter((f) => f.endsWith(".yaml")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export interface WorkflowStep {
  id: string;
  prompt_template: string;
  artifact: string;
  model?: string;
  max_iterations?: number;
  pass_condition?: string;
  on_fail?: string;
  max_retries?: number;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  triggers?: {
    github_label?: string;
  };
  steps: WorkflowStep[];
  post_steps?: {
    create_pr?: boolean;
    pr_title_template?: string;
  };
  labels?: {
    in_progress?: string;
    success?: string;
    failure?: string;
  };
  branch_template?: string;
  artifact_dir?: string;
}

export interface WorkflowLoaderDeps {
  logger: typeof logger;
  glob: (pattern: string) => Promise<string[]>;
  watch: typeof watch;
}

export class WorkflowLoader {
  private workflows: Map<string, WorkflowDefinition> = new Map();
  private watchers: Map<string, ReturnType<typeof watch>> = new Map();
  private deps: WorkflowLoaderDeps;

  constructor(deps: Partial<WorkflowLoaderDeps> = {}) {
    this.deps = { logger, glob: defaultGlob, watch, ...deps };
  }

  /** Load all workflow definitions from registered repo paths */
  async loadFromRepos(repoPaths: string[]): Promise<void> {
    for (const repoPath of repoPaths) {
      await this.loadFromRepo(repoPath);
    }
  }

  /** Load workflows from a single repo path */
  async loadFromRepo(repoPath: string): Promise<void> {
    const workflowDir = resolve(repoPath, ".agentboard", "workflows");
    if (!existsSync(workflowDir)) return;

    const files = await this.deps.glob(join(workflowDir, "*.yaml"));
    for (const file of files) {
      this.loadFile(file);
    }

    // Watch for changes
    if (!this.watchers.has(workflowDir)) {
      const watcher = this.deps.watch(workflowDir, {
        ignoreInitial: true,
      });
      watcher.on("add", (filePath) => {
        if (filePath.endsWith(".yaml")) {
          this.loadFile(filePath);
        }
      });
      watcher.on("change", (filePath) => {
        if (filePath.endsWith(".yaml")) {
          this.loadFile(filePath);
        }
      });
      watcher.on("unlink", (filePath) => {
        if (filePath.endsWith(".yaml")) {
          this.removeByPath(filePath);
        }
      });
      this.watchers.set(workflowDir, watcher);
    }
  }

  private loadFile(path: string): void {
    try {
      const content = readFileSync(path, "utf-8");
      const workflow = parseYaml(content) as WorkflowDefinition;
      if (!workflow.name || !workflow.steps) {
        this.deps.logger.warn(`Invalid workflow file (missing name or steps): ${path}`);
        return;
      }
      this.workflows.set(workflow.name, workflow);
      this.deps.logger.info(`Loaded workflow: ${workflow.name} from ${path}`);
    } catch (err) {
      this.deps.logger.error(`Failed to load workflow ${path}:`, err);
    }
  }

  private removeByPath(path: string): void {
    // Find and remove the workflow that came from this path
    // Since we don't track path->name mapping, reload would be needed
    // For now, log the removal
    this.deps.logger.info(`Workflow file removed: ${path}`);
  }

  /** Get a workflow by name */
  get(name: string): WorkflowDefinition | undefined {
    return this.workflows.get(name);
  }

  /** List all loaded workflows */
  list(): WorkflowDefinition[] {
    return Array.from(this.workflows.values());
  }

  /** Stop all file watchers */
  async close(): Promise<void> {
    for (const watcher of this.watchers.values()) {
      await watcher.close();
    }
    this.watchers.clear();
  }
}

export const workflowLoader = new WorkflowLoader();
