import { db as defaultDb } from "../../shared/db";
import { cards, workflowRuns } from "../../shared/db/schema";
import { eq } from "drizzle-orm";
import { tmuxManager as defaultTmuxManager } from "../infra/tmux-manager";
import { slotAllocator as defaultSlotAllocator } from "./slot-allocator";
import { slotPreparer as defaultSlotPreparer } from "./slot-preparer";
import { workflowLoader as defaultWorkflowLoader } from "./workflow-loader";
import { workflowOrchestrator as defaultWorkflowOrchestrator } from "./workflow-orchestrator";
import { eventBus as defaultEventBus } from "../../shared/event-bus";
import { logger as defaultLogger } from "../../utils/logger";
import { writeHooks as defaultWriteHooks } from "../infra/hook-writer";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAgentBranchName, buildStreamingCommand, getCardLogPath } from "./workflow-helpers";
import { cardService as defaultCardService } from "../cards/card-service";
import type { CardService } from "../cards/card-service";
import type { SlotPreparer } from "./slot-preparer";
import type { Logger, EventBus } from "./types";

export interface AgentExecutorDeps {
  db: typeof defaultDb;
  eventBus: EventBus;
  logger: Logger;
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
  slotPreparer: SlotPreparer;
  workflowLoader: { get: (id: string) => unknown };
  workflowOrchestrator: { run: (cardId: number) => Promise<void> };
  writeHooks: typeof defaultWriteHooks;
  cardService: CardService;
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
      slotPreparer: defaultSlotPreparer,
      workflowLoader: defaultWorkflowLoader,
      workflowOrchestrator: defaultWorkflowOrchestrator,
      writeHooks: defaultWriteHooks,
      cardService: defaultCardService,
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
      await this.deps.cardService.logEvent(cardId, "error", "No repo assigned");
      await this.deps.cardService.updateStatus(cardId, "failed");
      return;
    }

    await this.deps.cardService.logEvent(
      cardId,
      "execution_start",
      `repoId=${card.repoId}, mode=${card.executionMode}, branch=${card.branchMode}`,
    );

    // Delegate to workflow runner if card has a valid workflow
    if (card.workflowId) {
      const workflow = this.deps.workflowLoader.get(card.workflowId);
      if (workflow) {
        await this.deps.cardService.logEvent(
          cardId,
          "workflow_delegate",
          `workflow=${card.workflowId}`,
        );
        await this.deps.workflowOrchestrator.run(cardId);
        return;
      }
      await this.deps.cardService.logEvent(
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
      await this.deps.cardService.logEvent(cardId, "error", "tmux not available");
      await this.deps.cardService.updateStatus(cardId, "failed");
      return;
    }

    // Check if a slot is already claimed for this card (e.g. by queue manager)
    let slot = await this.deps.slotAllocator.getSlotForCard(cardId);
    if (!slot) {
      slot = await this.deps.slotAllocator.claimSlot(card.repoId!, cardId);
    }
    if (!slot) {
      await this.deps.cardService.logEvent(
        cardId,
        "queued",
        `No available slot for repoId=${card.repoId}`,
      );
      await this.deps.cardService.moveToColumn(cardId, "ready");
      await this.deps.cardService.updateStatus(cardId, "queued");
      return;
    }

    // Update card status to running
    await this.deps.cardService.updateStatus(cardId, "running");

    // Write .claude/settings.local.json with Stop hook in the slot directory
    this.deps.writeHooks(slot.path, cardId, this.port, "complete");
    await this.deps.cardService.logEvent(
      cardId,
      "hooks_written",
      `endpoint=complete, path=${slot.path}`,
    );

    await this.deps.cardService.logEvent(
      cardId,
      "slot_claimed",
      `slotId=${slot.id}, path=${slot.path}`,
    );

    // Create tmux session
    const { sessionName, created } = this.deps.tmuxManager.createSession(cardId, slot.path);
    if (created) {
      await this.deps.cardService.logEvent(
        cardId,
        "tmux_session_created",
        `session=${sessionName}, cwd=${slot.path}`,
      );
    }

    // Check for existing branch from a previous run (resume/rerun case)
    const previousRuns = await this.deps.db
      .select({ branch: workflowRuns.branch })
      .from(workflowRuns)
      .where(eq(workflowRuns.cardId, cardId));
    const existingBranch = previousRuns.find((r) => r.branch)?.branch ?? null;

    // Prepare the slot: sync git, set up branch, install deps
    const branchName = buildAgentBranchName(cardId, card.title);
    const prepResult = await this.deps.slotPreparer.prepare({
      slotPath: slot.path,
      branchMode: card.branchMode as "create" | "current",
      branch: branchName,
      existingBranch,
    });

    // Log all prep events
    for (const event of prepResult.events) {
      await this.deps.cardService.logEvent(cardId, event.type, event.detail);
    }

    const branch = prepResult.branch;

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

    const prompt = card.description ?? card.title;

    // Build the tmux command based on execution mode
    let command: string;
    if (card.executionMode !== "interactive") {
      const promptDir = resolve(slot.path, ".agentboard");
      mkdirSync(promptDir, { recursive: true });
      const promptFile = resolve(promptDir, `card-${cardId}-prompt.md`);
      writeFileSync(promptFile, prompt);
      const logPath = getCardLogPath(cardId);
      command = buildStreamingCommand(
        ["-p", "--dangerously-skip-permissions", `@${promptFile}`],
        logPath,
      );
    } else {
      command = `claude`;
    }

    this.deps.tmuxManager.sendCommand(sessionName, command);
    await this.deps.cardService.logEvent(cardId, "agent_command_sent", `session=${sessionName}`);

    this.deps.tmuxManager.startCapture(sessionName, (output) => {
      this.deps.eventBus.emit("agent:output", { cardId, content: output });
    });

    await this.deps.cardService.logEvent(
      cardId,
      "agent_started",
      `session=${sessionName}, mode=${card.executionMode}`,
    );
    this.deps.logger.info(
      `Card ${cardId} execution started in session ${sessionName}, Stop hook configured`,
    );
  }
}

export const agentExecutor = new AgentExecutor();
