import { db } from "../db";
import { cards, workflowRuns } from "../db/schema";
import { eq } from "drizzle-orm";
import { tmuxManager } from "./tmux-manager";
import { slotAllocator } from "./slot-allocator";
import { workflowLoader } from "./workflow-loader";
import { workflowRunner } from "./workflow-runner";
import { eventBus } from "../utils/event-bus";
import { logger } from "../utils/logger";
import { writeHooks } from "../utils/hook-writer";
import { shellEscape } from "../utils/workflow-helpers";
import { logCardEvent } from "../utils/card-events";

/**
 * Handles single agent execution: claim slot, configure Stop hook,
 * create tmux session, spawn Claude Code CLI.
 *
 * Completion is detected via Claude Code's Stop hook (HTTP POST to callback endpoint),
 * not by polling tmux session status.
 */
export class AgentExecutor {
  private port: number;

  constructor(port = 4200) {
    this.port = port;
  }

  /** Start agent execution for a card moved to in_progress */
  async startExecution(cardId: number): Promise<void> {
    // Fetch the card
    const cardRows = await db.select().from(cards).where(eq(cards.id, cardId));
    if (cardRows.length === 0) {
      logger.error(`Card ${cardId} not found`);
      return;
    }
    const card = cardRows[0]!;

    if (!card.repoId) {
      await logCardEvent(cardId, "error", "No repo assigned");
      await this.updateCardStatus(cardId, "failed");
      return;
    }

    await logCardEvent(
      cardId,
      "execution_start",
      `repoId=${card.repoId}, mode=${card.executionMode}, branch=${card.branchMode}`,
    );

    // Delegate to workflow runner if card has a valid workflow
    if (card.workflowId) {
      const workflow = workflowLoader.get(card.workflowId);
      if (workflow) {
        await logCardEvent(cardId, "workflow_delegate", `workflow=${card.workflowId}`);
        await workflowRunner.run(cardId);
        return;
      }
      await logCardEvent(
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
    if (!tmuxManager.isAvailable()) {
      await logCardEvent(cardId, "error", "tmux not available");
      await this.updateCardStatus(cardId, "failed");
      return;
    }

    // Check if a slot is already claimed for this card (e.g. by queue manager)
    let slot = await slotAllocator.getSlotForCard(cardId);
    if (!slot) {
      slot = await slotAllocator.claimSlot(card.repoId!, cardId);
    }
    if (!slot) {
      await logCardEvent(cardId, "queued", `No available slot for repoId=${card.repoId}`);
      await db
        .update(cards)
        .set({ column: "ready", status: "queued", updatedAt: new Date() })
        .where(eq(cards.id, cardId));
      eventBus.emit("card:moved", { cardId, fromColumn: "in_progress", toColumn: "ready" });
      eventBus.emit("card:status-changed", { cardId, status: "queued" });
      return;
    }

    // Update card status to running
    await this.updateCardStatus(cardId, "running");

    // Write .claude/settings.local.json with Stop hook in the slot directory
    writeHooks(slot.path, cardId, this.port, "complete");
    await logCardEvent(cardId, "hooks_written", `endpoint=complete, path=${slot.path}`);

    await logCardEvent(cardId, "slot_claimed", `slotId=${slot.id}, path=${slot.path}`);

    // Create tmux session
    const { sessionName, created } = tmuxManager.createSession(cardId, slot.path);
    if (created) {
      await logCardEvent(
        cardId,
        "tmux_session_created",
        `session=${sessionName}, cwd=${slot.path}`,
      );
    }

    // Branch handling
    const { execSync } = await import("node:child_process");
    let branch: string | null = null;

    // Check for existing branch from a previous run (resume/rerun case)
    const previousRuns = await db
      .select({ branch: workflowRuns.branch })
      .from(workflowRuns)
      .where(eq(workflowRuns.cardId, cardId));
    const existingBranch = previousRuns.find((r) => r.branch)?.branch ?? null;

    if (existingBranch) {
      // Reuse existing branch from previous run
      try {
        execSync(`git checkout ${existingBranch}`, {
          cwd: slot.path,
          stdio: "ignore",
          timeout: 10000,
        });
        branch = existingBranch;
        await logCardEvent(cardId, "branch_reused", existingBranch);
      } catch {
        await logCardEvent(
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
        execSync("git checkout -- . && git clean -fd", {
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
        execSync("git checkout main && git pull --ff-only", {
          cwd: slot.path,
          stdio: "ignore",
          timeout: 15000,
        });
      } catch {
        await logCardEvent(cardId, "warn", "Could not checkout/pull main before branching");
      }
      try {
        execSync(`git checkout -b ${branchName}`, { cwd: slot.path, stdio: "ignore" });
        branch = branchName;
        await logCardEvent(cardId, "branch_created", branchName);
      } catch {
        // Branch may exist — try switching to it
        try {
          execSync(`git checkout ${branchName}`, { cwd: slot.path, stdio: "ignore" });
          branch = branchName;
        } catch {
          // Fall back to current branch
          try {
            branch = execSync("git rev-parse --abbrev-ref HEAD", {
              cwd: slot.path,
              encoding: "utf-8",
              timeout: 3000,
            }).trim();
          } catch {
            /* not a git repo */
          }
        }
      }
    } else if (!branch) {
      // Stay on current branch
      try {
        branch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: slot.path,
          encoding: "utf-8",
          timeout: 3000,
        }).trim();
      } catch {
        /* not a git repo */
      }
    }

    // Run package installer if a lockfile exists
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const hasLockfile =
      existsSync(join(slot.path, "pnpm-lock.yaml")) ||
      existsSync(join(slot.path, "bun.lock")) ||
      existsSync(join(slot.path, "package-lock.json"));

    if (hasLockfile) {
      try {
        if (existsSync(join(slot.path, "pnpm-lock.yaml"))) {
          execSync("pnpm install --frozen-lockfile", {
            cwd: slot.path,
            stdio: "ignore",
            timeout: 60000,
          });
          await logCardEvent(cardId, "deps_installed", "pnpm install");
        } else if (existsSync(join(slot.path, "bun.lock"))) {
          execSync("bun install --frozen-lockfile", {
            cwd: slot.path,
            stdio: "ignore",
            timeout: 60000,
          });
          await logCardEvent(cardId, "deps_installed", "bun install");
        } else {
          execSync("npm ci", { cwd: slot.path, stdio: "ignore", timeout: 60000 });
          await logCardEvent(cardId, "deps_installed", "npm ci");
        }
      } catch {
        await logCardEvent(cardId, "warn", "Package install failed — continuing anyway");
      }
    }

    // Create workflow run record
    await db
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

    // Build the Claude Code command
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
    args.push("--max-turns 50");
    args.push(`--append-system-prompt ${shellEscape(systemPrompt)}`);
    args.push(`-p ${shellEscape(prompt)}`);

    const command = `claude \\\n  ${args.join(" \\\n  ")}`;

    // Send command to tmux session
    tmuxManager.sendCommand(sessionName, command);
    await logCardEvent(cardId, "agent_command_sent", `session=${sessionName}`);

    // Start capturing output and forwarding via event bus
    tmuxManager.startCapture(sessionName, (output) => {
      eventBus.emit("agent:output", { cardId, content: output });
    });

    await logCardEvent(
      cardId,
      "agent_started",
      `session=${sessionName}, mode=${card.executionMode}`,
    );
    logger.info(`Card ${cardId} execution started in session ${sessionName}, Stop hook configured`);
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
    await db.update(cards).set({ status, updatedAt: new Date() }).where(eq(cards.id, cardId));

    eventBus.emit("card:status-changed", { cardId, status });
  }
}

export const agentExecutor = new AgentExecutor();
