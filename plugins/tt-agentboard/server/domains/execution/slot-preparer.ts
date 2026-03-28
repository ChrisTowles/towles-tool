import { execSync as defaultExecSync } from "node:child_process";
import { existsSync as defaultExistsSync } from "node:fs";
import { join } from "node:path";
import { logger as defaultLogger } from "../../utils/logger";
import type { Logger } from "./types";

export interface SlotPreparerDeps {
  logger: Logger;
  execSync: typeof defaultExecSync;
  existsSync: typeof defaultExistsSync;
}

export interface PrepareSlotOptions {
  slotPath: string;
  branchMode: "create" | "current";
  /** Branch name to create (branchMode="create") or checkout (branchMode="current") */
  branch: string;
  /** Existing branch from a previous run — takes precedence if set */
  existingBranch?: string | null;
}

export interface SlotEvent {
  type: string;
  detail: string;
}

export interface PrepareSlotResult {
  branch: string;
  depsInstalled: boolean;
  packageManager: string | null;
  events: SlotEvent[];
}

export interface ResetSlotResult {
  depsInstalled: boolean;
  packageManager: string | null;
  events: SlotEvent[];
}

interface LockfileEntry {
  file: string;
  manager: string;
  command: string;
}

const LOCKFILES: LockfileEntry[] = [
  { file: "pnpm-lock.yaml", manager: "pnpm", command: "pnpm install --frozen-lockfile" },
  { file: "bun.lock", manager: "bun", command: "bun install --frozen-lockfile" },
  { file: "package-lock.json", manager: "npm", command: "npm ci" },
  { file: "uv.lock", manager: "uv", command: "uv sync --frozen" },
  { file: "requirements.txt", manager: "pip", command: "pip install -r requirements.txt" },
];

/**
 * Manages slot workspace preparation for agent execution.
 *
 * Two entry points:
 * - reset(): Called when a slot is released back to the pool.
 *   Syncs with main and installs deps so the slot is ready for the next card.
 * - prepare(): Called when a slot is claimed for a new card.
 *   Re-syncs main + installs deps (in case of manual changes), then sets up the branch.
 */
export class SlotPreparer {
  private deps: SlotPreparerDeps;

  constructor(deps: Partial<SlotPreparerDeps> = {}) {
    this.deps = {
      logger: defaultLogger,
      execSync: defaultExecSync,
      existsSync: defaultExistsSync,
      ...deps,
    };
  }

  /**
   * Reset a slot after release: clean working tree, checkout main, pull, install deps.
   * This runs at release time so the slot is warm and ready for the next claim.
   */
  async reset(slotPath: string): Promise<ResetSlotResult> {
    const events: SlotEvent[] = [];

    this.syncToMain(slotPath, events);
    const { installed, packageManager } = this.installDeps(slotPath, events);

    this.deps.logger.info(`Slot reset complete: ${slotPath}`);
    return { depsInstalled: installed, packageManager, events };
  }

  /**
   * Prepare a slot for a specific card: sync git, set up branch, install deps.
   * Called at claim time before the agent starts working.
   */
  async prepare(options: PrepareSlotOptions): Promise<PrepareSlotResult> {
    const events: SlotEvent[] = [];
    let branch: string;

    if (options.existingBranch) {
      // Resume case: checkout existing branch from previous run
      branch = this.checkoutBranch(options.slotPath, options.existingBranch, events);
    } else if (options.branchMode === "create") {
      // New work: sync with main, then create branch
      branch = this.syncMainAndBranch(options.slotPath, options.branch, events);
    } else {
      // branchMode="current": checkout the specified branch
      branch = this.checkoutBranch(options.slotPath, options.branch, events);
    }

    // Install deps (cached from reset, so typically fast)
    const { installed, packageManager } = this.installDeps(options.slotPath, events);

    return { branch, depsInstalled: installed, packageManager, events };
  }

  /** Clean working tree, checkout main, pull latest */
  private syncToMain(slotPath: string, events: SlotEvent[]): void {
    // Discard any leftover changes
    try {
      this.deps.execSync("git checkout -- . && git clean -fd", {
        cwd: slotPath,
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {
      /* non-fatal */
    }

    // Checkout main and pull
    try {
      this.deps.execSync("git checkout main && git pull --ff-only", {
        cwd: slotPath,
        stdio: "ignore",
        timeout: 15000,
      });
      events.push({ type: "main_synced", detail: "Checked out and pulled main" });
    } catch {
      events.push({ type: "warn", detail: "Could not checkout/pull main" });
    }
  }

  /** Sync with main then create a new branch */
  private syncMainAndBranch(slotPath: string, branchName: string, events: SlotEvent[]): string {
    this.syncToMain(slotPath, events);

    // Create branch
    try {
      this.deps.execSync(`git checkout -b ${branchName}`, { cwd: slotPath, stdio: "ignore" });
      events.push({ type: "branch_created", detail: branchName });
      return branchName;
    } catch {
      // Branch may exist — try switching to it
      try {
        this.deps.execSync(`git checkout ${branchName}`, { cwd: slotPath, stdio: "ignore" });
        events.push({ type: "branch_reused", detail: branchName });
        return branchName;
      } catch {
        return this.getCurrentBranch(slotPath, events);
      }
    }
  }

  /** Checkout an existing branch (for branchMode="current" or resume) */
  private checkoutBranch(slotPath: string, branch: string, events: SlotEvent[]): string {
    try {
      this.deps.execSync(`git fetch origin ${branch}`, {
        cwd: slotPath,
        stdio: "ignore",
        timeout: 15000,
      });
    } catch {
      /* non-fatal — branch may be local only */
    }

    try {
      this.deps.execSync(`git checkout ${branch}`, {
        cwd: slotPath,
        stdio: "ignore",
        timeout: 10000,
      });
      events.push({ type: "branch_checked_out", detail: branch });
      return branch;
    } catch {
      events.push({ type: "warn", detail: `Could not checkout branch ${branch}` });
      return this.getCurrentBranch(slotPath, events);
    }
  }

  private getCurrentBranch(slotPath: string, events: SlotEvent[]): string {
    try {
      const current = (
        this.deps.execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: slotPath,
          encoding: "utf-8",
          timeout: 3000,
        }) as unknown as string
      ).trim();
      events.push({ type: "branch_fallback", detail: current });
      return current;
    } catch {
      return "unknown";
    }
  }

  /** Detect and run the appropriate package manager */
  private installDeps(
    slotPath: string,
    events: SlotEvent[],
  ): { installed: boolean; packageManager: string | null } {
    for (const { file, manager, command } of LOCKFILES) {
      if (this.deps.existsSync(join(slotPath, file))) {
        return this.runInstall(slotPath, manager, command, events);
      }
    }

    return { installed: false, packageManager: null };
  }

  private runInstall(
    slotPath: string,
    name: string,
    command: string,
    events: SlotEvent[],
  ): { installed: boolean; packageManager: string } {
    try {
      this.deps.execSync(command, { cwd: slotPath, stdio: "ignore", timeout: 120000 });
      events.push({ type: "deps_installed", detail: `${name}: ${command}` });
      return { installed: true, packageManager: name };
    } catch {
      events.push({ type: "warn", detail: `${name} install failed — continuing anyway` });
      return { installed: false, packageManager: name };
    }
  }
}

export const slotPreparer = new SlotPreparer();
