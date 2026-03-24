import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { watch } from "chokidar";
import { glob } from "glob";
import { logger } from "../utils/logger";

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

export class WorkflowLoader {
  private workflows: Map<string, WorkflowDefinition> = new Map();
  private watchers: Map<string, ReturnType<typeof watch>> = new Map();

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

    const files = await glob(join(workflowDir, "*.yaml"));
    for (const file of files) {
      this.loadFile(file);
    }

    // Watch for changes
    if (!this.watchers.has(workflowDir)) {
      const watcher = watch(workflowDir, {
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
        logger.warn(`Invalid workflow file (missing name or steps): ${path}`);
        return;
      }
      this.workflows.set(workflow.name, workflow);
      logger.info(`Loaded workflow: ${workflow.name} from ${path}`);
    } catch (err) {
      logger.error(`Failed to load workflow ${path}:`, err);
    }
  }

  private removeByPath(path: string): void {
    // Find and remove the workflow that came from this path
    // Since we don't track path->name mapping, reload would be needed
    // For now, log the removal
    logger.info(`Workflow file removed: ${path}`);
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
