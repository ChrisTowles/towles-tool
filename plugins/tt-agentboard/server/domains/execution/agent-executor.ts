import { db as defaultDb } from "../../shared/db";
import { cards, workflowRuns } from "../../shared/db/schema";
import { eq } from "drizzle-orm";
import { execSync as defaultExecSync } from "node:child_process";
import { existsSync as defaultExistsSync } from "node:fs";
import { join } from "node:path";
import { tmuxManager as defaultTmuxManager } from "../infra/tmux-manager";
import { slotAllocator as defaultSlotAllocator } from "./slot-allocator";
import { workflowLoader as defaultWorkflowLoader } from "./workflow-loader";
import { workflowRunner as defaultWorkflowRunner } from "./workflow-runner";
import { eventBus as defaultEventBus } from "../../utils/event-bus";
import { logger as defaultLogger } from "../../utils/logger";
import { writeHooks as defaultWriteHooks } from "../infra/hook-writer";
import { buildStreamingCommand, shellEscape } from "./workflow-helpers";
import { logCardEvent as defaultLogCardEvent } from "../../utils/card-events";
import { streamTailer as defaultStreamTailer } from "../infra/stream-tailer";

export interface AgentExecutorDeps {
  db: typeof defaultDb;
  eventBus: { emit: (event: string, ...args: unknown[]) => boolean | void };
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  tmuxManager: {
    isAvailable: () => boolean;
    createSession: (cardId: number, cwd: string) => { sessionName: string; created: boolean };
    startCapture: (sessionName: string, cb: (data: string) => void) => void;
    stopCapture: (sessionName: string) => void;
    killSession: (sessionName: string) => boolean;
    sendCommand: (sessionName: string, command: string) => void;
  };
  slotAllocator: {
    claimSlot: (repoId: number, cardId: number) => Promise<{ id: number; path: string } | null>;
    releaseSlot: (slotId: number) => Promise<void>;
    getSlotForCard: (cardId: number) => Promise<{ id: number; path: string } | null>;
  };
  workflowLoader: { get: (id: string) => unknown };
  workflowRunner: { run: (cardId: number) => Promise<void> };
  writeHooks: typeof defaultWriteHooks;
  logCardEvent: typeof defaultLogCardEvent;
  streamTailer: {
    startTailing: (cardId: number, logFilePath: string) => Promise<void>;
    stopTailing: (cardId: number) => void;
  };
  execSync: typeof defaultExecSync;
  existsSync: typeof defaultExistsSync;
}

/**
 * Handles single agent execution: claim slot, configure Stop hook,
 * create tmux session, spawn Claude Code CLI.
 *
 * Completion is detected via Claude Code's Stop hook (HTTP POST to callback endpoint),
 * not by polling tmux session status.
 */
export class AgentExecutor {
  private port: number;
  private deps: AgentExecutorDeps;

  constructor(port = 4200, deps: Partial<AgentExecutorDeps> = {}) {
    this.port = port;
    this.deps = {
      db: defaultDb,
      eventBus: defaultEventBus,
      logger: defaultLogger,
      tmuxManager: defaultTmuxManager,
      slotAllocator: defaultSlotAllocator,
      workflowLoader: defaultWorkflowLoader,
      workflowRunner: defaultWorkflowRunner,
      writeHooks: defaultWriteHooks,
      logCardEvent: defaultLogCardEvent,
      streamTailer: defaultStreamTailer,
      execSync: defaultExecSync,
      existsSync: defaultExistsSync,
      ...deps,
    };
  }

  /** Start agent execution for a card moved to in_progress */
  async startExecution(cardId: number): Promise<void> {
    // Fetch the card
    const cardRows = await this.deps.db.select().from(cards).where(eq(cards.id, cardId));
    if (cardRows.length === 0) {
      this.deps.logger.error(`Card ${cardId} not found`);
      return;
    }
    const card = cardRows[0]!;

    if (!card.repoId) {
      await this.deps.logCardEvent(cardId, "error", "No repo assigned");
      await this.updateCardStatus(cardId, "failed");
      return;
    }

    await this.deps.logCardEvent(
      cardId,
      "execution_start",
      `repoId=${card.repoId}, mode=${card.executionMode}, branch=${card.branchMode}`,
    );

    // Delegate to workflow runner if card has a valid workflow
    if (card.workflowId) {
      const workflow = this.deps.workflowLoader.get(card.workflowId);
      if (workflow) {
        await this.deps.logCardEvent(cardId, "workflow_delegate", `workflow=${card.workflowId}`);
        await this.deps.workflowRunner.run(cardId);
        return;
      }
      await this.deps.logCardEvent(
        cardId,
        "workflow_not_found",
        `workflow=${card.workflowId}, falling back to single-prompt`,
      );
    }

    // Single-prompt execution (no workflow)
    await this.runSinglePrompt(cardId, card);
  }

  /** Run a single claude -p command for cards without a workflow */
  private async runSinglePrompt(cardId: number, card: typeof cards.$inferSelect): Promise<void> {
    // Check tmux availability
    if (!this.deps.tmuxManager.isAvailable()) {
      await this.deps.logCardEvent(cardId, "error", "tmux not available");
      await this.updateCardStatus(cardId, "failed");
      return;
    }

    // Check if a slot is already claimed for this card (e.g. by queue manager)
    let slot = await this.deps.slotAllocator.getSlotForCard(cardId);
    if (!slot) {
      slot = await this.deps.slotAllocator.claimSlot(card.repoId!, cardId);
    }
    if (!slot) {
      await this.deps.logCardEvent(cardId, "queued", `No available slot for repoId=${card.repoId}`);
      await this.deps.db
        .update(cards)
        .set({ column: "ready", status: "queued", updatedAt: new Date() })
        .where(eq(cards.id, cardId));
      this.deps.eventBus.emit("card:moved", {
        cardId,
        fromColumn: "in_progress",
        toColumn: "ready",
      });
      this.deps.eventBus.emit("card:status-changed", { cardId, status: "queued" });
      return;
    }

    // Update card status to running
    await this.updateCardStatus(cardId, "running");

    // Write .claude/settings.local.json with Stop hook in the slot directory
    this.deps.writeHooks(slot.path, cardId, this.port, "complete");
    await this.deps.logCardEvent(cardId, "hooks_written", `endpoint=complete, path=${slot.path}`);

    await this.deps.logCardEvent(cardId, "slot_claimed", `slotId=${slot.id}, path=${slot.path}`);

    // Create tmux session
    const { sessionName, created } = this.deps.tmuxManager.createSession(cardId, slot.path);
    if (created) {
      await this.deps.logCardEvent(
        cardId,
        "tmux_session_created",
        `session=${sessionName}, cwd=${slot.path}`,
      );
    }

    // Branch handling
    let branch: string | null = null;

    // Check for existing branch from a previous run (resume/rerun case)
    const previousRuns = await this.deps.db
      .select({ branch: workflowRuns.branch })
      .from(workflowRuns)
      .where(eq(workflowRuns.cardId, cardId));
    const existingBranch = previousRuns.find((r) => r.branch)?.branch ?? null;

    if (existingBranch) {
      // Reuse existing branch from previous run
      try {
        this.deps.execSync(`git checkout ${existingBranch}`, {
          cwd: slot.path,
          stdio: "ignore",
          timeout: 10000,
        });
        branch = existingBranch;
        await this.deps.logCardEvent(cardId, "branch_reused", existingBranch);
      } catch {
        await this.deps.logCardEvent(
          cardId,
          "warn",
          `Could not checkout existing branch ${existingBranch}, creating new`,
        );
        // Fall through to normal branch creation
      }
    }

    if (!branch && card.branchMode === "create") {
      // Clean working tree of leftover files from previous agents
      try {
        this.deps.execSync("git checkout -- . && git clean -fd", {
          cwd: slot.path,
          stdio: "ignore",
          timeout: 5000,
        });
      } catch {
        /* non-fatal */
      }

      // Start from a clean, up-to-date main before branching
      const branchName = `agentboard/card-${cardId}`;
      try {
        this.deps.execSync("git checkout main && git pull --ff-only", {
          cwd: slot.path,
          stdio: "ignore",
          timeout: 15000,
        });
      } catch {
        await this.deps.logCardEvent(
          cardId,
          "warn",
          "Could not checkout/pull main before branching",
        );
      }
      try {
        this.deps.execSync(`git checkout -b ${branchName}`, { cwd: slot.path, stdio: "ignore" });
        branch = branchName;
        await this.deps.logCardEvent(cardId, "branch_created", branchName);
      } catch {
        // Branch may exist — try switching to it
        try {
          this.deps.execSync(`git checkout ${branchName}`, { cwd: slot.path, stdio: "ignore" });
          branch = branchName;
        } catch {
          // Fall back to current branch
          try {
            branch = (
              this.deps.execSync("git rev-parse --abbrev-ref HEAD", {
                cwd: slot.path,
                encoding: "utf-8",
                timeout: 3000,
              }) as unknown as string
            ).trim();
          } catch {
            /* not a git repo */
          }
        }
      }
    } else if (!branch) {
      // Stay on current branch
      try {
        branch = (
          this.deps.execSync("git rev-parse --abbrev-ref HEAD", {
            cwd: slot.path,
            encoding: "utf-8",
            timeout: 3000,
          }) as unknown as string
        ).trim();
      } catch {
        /* not a git repo */
      }
    }

    // Run package installer if a lockfile exists
    const hasLockfile =
      this.deps.existsSync(join(slot.path, "pnpm-lock.yaml")) ||
      this.deps.existsSync(join(slot.path, "bun.lock")) ||
      this.deps.existsSync(join(slot.path, "package-lock.json"));

    if (hasLockfile) {
      try {
        if (this.deps.existsSync(join(slot.path, "pnpm-lock.yaml"))) {
          this.deps.execSync("pnpm install --frozen-lockfile", {
            cwd: slot.path,
            stdio: "ignore",
            timeout: 60000,
          });
          await this.deps.logCardEvent(cardId, "deps_installed", "pnpm install");
        } else if (this.deps.existsSync(join(slot.path, "bun.lock"))) {
          this.deps.execSync("bun install --frozen-lockfile", {
            cwd: slot.path,
            stdio: "ignore",
            timeout: 60000,
          });
          await this.deps.logCardEvent(cardId, "deps_installed", "bun install");
        } else {
          this.deps.execSync("npm ci", { cwd: slot.path, stdio: "ignore", timeout: 60000 });
          await this.deps.logCardEvent(cardId, "deps_installed", "npm ci");
        }
      } catch {
        await this.deps.logCardEvent(cardId, "warn", "Package install failed — continuing anyway");
      }
    }

    // Create workflow run record
    await this.deps.db
      .insert(workflowRuns)
      .values({
        cardId,
        workflowId: card.workflowId ?? "default",
        slotId: slot.id,
        tmuxSession: sessionName,
        branch,
        startedAt: new Date(),
      })
      .returning();

    // TODO: add --model flag from card config
    // TODO: add --permission-mode instead of binary headless/interactive
    // TODO: add --verbose flag option
    // TODO: consider --append-system-prompt for card-level custom instructions
    const prompt = card.description ?? card.title;
    const systemPrompt =
      "You are an autonomous agent. Complete the task fully without asking clarifying questions. " +
      "Make your best judgment and implement the solution. Do not ask the user for confirmation — just do the work. " +
      "IMPORTANT: When you are done, you MUST commit your changes with git add and git commit. Do not leave uncommitted files.";

    const args: string[] = [];
    if (card.executionMode !== "interactive") {
      args.push("--dangerously-skip-permissions");
    }
    args.push("--max-turns", "50");
    args.push("--append-system-prompt", shellEscape(systemPrompt));
    args.push("-p", shellEscape(prompt));

    const logFilePath = join(slot.path, ".claude-stream.ndjson");
    const command = buildStreamingCommand(args, logFilePath);

    this.deps.tmuxManager.sendCommand(sessionName, command);
    await this.deps.logCardEvent(cardId, "agent_command_sent", `session=${sessionName}`);

    // Start tailing the stream-json output for structured activity events
    await this.deps.streamTailer.startTailing(cardId, logFilePath);

    this.deps.tmuxManager.startCapture(sessionName, (output) => {
      this.deps.eventBus.emit("agent:output", { cardId, content: output });
    });

    await this.deps.logCardEvent(
      cardId,
      "agent_started",
      `session=${sessionName}, mode=${card.executionMode}`,
    );
    this.deps.logger.info(
      `Card ${cardId} execution started in session ${sessionName}, Stop hook configured`,
    );
  }

  private async updateCardStatus(
    cardId: number,
    status:
      | "idle"
      | "queued"
      | "running"
      | "waiting_input"
      | "review_ready"
      | "done"
      | "failed"
      | "blocked",
  ): Promise<void> {
    await this.deps.db
      .update(cards)
      .set({ status, updatedAt: new Date() })
      .where(eq(cards.id, cardId));

    this.deps.eventBus.emit("card:status-changed", { cardId, status });
  }
}

export const agentExecutor = new AgentExecutor();
