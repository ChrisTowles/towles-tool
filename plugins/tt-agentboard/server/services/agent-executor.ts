import { db } from "../db";
import { cards, workflowRuns } from "../db/schema";
import { eq } from "drizzle-orm";
import { tmuxManager } from "./tmux-manager";
import { slotAllocator } from "./slot-allocator";
import { eventBus } from "../utils/event-bus";
import { logger } from "../utils/logger";

/**
 * Handles single agent execution: claim slot, create tmux session,
 * spawn Claude Code CLI, stream output, move card on completion.
 */
export class AgentExecutor {
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

    // Create tmux session
    const sessionName = tmuxManager.createSession(cardId, slot.path);

    // Create workflow run record
    const workflowRunRows = await db
      .insert(workflowRuns)
      .values({
        cardId,
        workflowId: card.workflowId ?? "default",
        slotId: slot.id,
        tmuxSession: sessionName,
        startedAt: new Date(),
      })
      .returning();
    const workflowRun = workflowRunRows[0]!;

    // Build the Claude Code command
    const prompt = card.description ?? card.title;
    const modelFlag = card.executionMode === "interactive" ? "" : "--dangerously-skip-permissions";
    const command = `claude --message ${this.shellEscape(prompt)} ${modelFlag}`.trim();

    // Send command to tmux session
    tmuxManager.sendCommand(sessionName, command);

    // Start capturing output and forwarding via event bus
    tmuxManager.startCapture(sessionName, (output) => {
      eventBus.emit("agent:output", { cardId, content: output });
    });

    // Monitor for session completion
    this.monitorCompletion(cardId, sessionName, slot.id, workflowRun.id);
  }

  /** Poll for tmux session exit to detect completion */
  private monitorCompletion(
    cardId: number,
    sessionName: string,
    slotId: number,
    workflowRunId: number,
  ): void {
    const interval = setInterval(async () => {
      if (tmuxManager.sessionExists(sessionName)) return;

      // Session ended
      clearInterval(interval);
      tmuxManager.stopCapture(sessionName);

      // Update workflow run
      await db
        .update(workflowRuns)
        .set({
          status: "completed",
          endedAt: new Date(),
        })
        .where(eq(workflowRuns.id, workflowRunId));

      // Move card to review
      await db
        .update(cards)
        .set({
          column: "review",
          status: "review_ready",
          updatedAt: new Date(),
        })
        .where(eq(cards.id, cardId));

      // Release slot
      await slotAllocator.releaseSlot(slotId);

      eventBus.emit("card:moved", {
        cardId,
        fromColumn: "in_progress",
        toColumn: "review",
      });
      eventBus.emit("card:status-changed", {
        cardId,
        status: "review_ready",
      });
      eventBus.emit("workflow:completed", { cardId, status: "completed" });

      logger.info(`Card ${cardId} execution completed, moved to review`);
    }, 2000);
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
