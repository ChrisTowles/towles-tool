import { db } from "../db";
import { cards, workflowRuns } from "../db/schema";
import { eq } from "drizzle-orm";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmuxManager } from "./tmux-manager";
import { slotAllocator } from "./slot-allocator";
import { eventBus } from "../utils/event-bus";
import { logger } from "../utils/logger";

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
      logger.error(`Card ${cardId} has no repo assigned`);
      await this.updateCardStatus(cardId, "failed");
      return;
    }

    // Check tmux availability
    if (!tmuxManager.isAvailable()) {
      logger.error("tmux is not available on this system");
      await this.updateCardStatus(cardId, "failed");
      return;
    }

    // Claim a workspace slot
    const slot = await slotAllocator.claimSlot(card.repoId, cardId);
    if (!slot) {
      logger.warn(`No available slot for card ${cardId}, marking as queued`);
      await this.updateCardStatus(cardId, "queued");
      return;
    }

    // Update card status to running
    await this.updateCardStatus(cardId, "running");

    // Write .claude/settings.local.json with Stop hook in the slot directory
    this.writeStopHook(slot.path, cardId);

    // Create tmux session
    const sessionName = tmuxManager.createSession(cardId, slot.path);

    // Create workflow run record
    await db
      .insert(workflowRuns)
      .values({
        cardId,
        workflowId: card.workflowId ?? "default",
        slotId: slot.id,
        tmuxSession: sessionName,
        startedAt: new Date(),
      })
      .returning();

    // Build the Claude Code command
    const prompt = card.description ?? card.title;
    const modelFlag = card.executionMode === "interactive" ? "" : "--dangerously-skip-permissions";
    const command = `claude -p ${this.shellEscape(prompt)} ${modelFlag}`.trim();

    // Send command to tmux session
    tmuxManager.sendCommand(sessionName, command);

    // Start capturing output and forwarding via event bus
    tmuxManager.startCapture(sessionName, (output) => {
      eventBus.emit("agent:output", { cardId, content: output });
    });

    logger.info(`Card ${cardId} execution started in session ${sessionName}, Stop hook configured`);
  }

  /**
   * Write .claude/settings.local.json with a Stop hook that POSTs
   * to the AgentBoard callback endpoint when Claude finishes.
   */
  private writeStopHook(slotPath: string, cardId: number): void {
    const claudeDir = resolve(slotPath, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    const settingsPath = resolve(claudeDir, "settings.local.json");

    // Read existing settings if present, merge hooks
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } catch {
        // Corrupted file, start fresh
      }
    }

    const callbackUrl = `http://localhost:${this.port}/api/agents/${cardId}/complete`;

    settings.hooks = {
      ...(settings.hooks as Record<string, unknown> | undefined),
      Stop: [
        {
          matcher: "",
          hooks: [
            {
              type: "http",
              url: callbackUrl,
            },
          ],
        },
      ],
    };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    logger.info(`Wrote Stop hook to ${settingsPath} → ${callbackUrl}`);
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

  /** Escape a string for safe use in shell commands */
  private shellEscape(str: string): string {
    return `'${str.replace(/'/g, "'\\''")}'`;
  }
}

export const agentExecutor = new AgentExecutor();
