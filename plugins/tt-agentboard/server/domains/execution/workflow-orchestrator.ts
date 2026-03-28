import { db as defaultDb } from "../../shared/db";
import { cards, workflowRuns, repositories } from "../../shared/db/schema";
import { eq } from "drizzle-orm";
import { execSync as defaultExecSync } from "node:child_process";
import { tmuxManager as defaultTmuxManager } from "../infra/tmux-manager";
import { slotAllocator as defaultSlotAllocator } from "./slot-allocator";
import { workflowLoader as defaultWorkflowLoader } from "./workflow-loader";
import { contextBundler as defaultContextBundler } from "./context-bundler";
import type { WorkflowDefinition } from "./workflow-loader";
import { eventBus as defaultEventBus } from "../../shared/event-bus";
import { logger as defaultLogger } from "../../utils/logger";
import { cardService as defaultCardService } from "../cards/card-service";
import type { CardService } from "../cards/card-service";
import { streamTailer as defaultStreamTailer } from "../infra/stream-tailer";
import { stepExecutor as defaultStepExecutor, clearPendingCallback } from "./step-executor";
import type { StepExecutor, WorkflowContext } from "./step-executor";
import { renderTemplate, shellEscape } from "./workflow-helpers";
import type { Logger, EventBus, StreamTailer } from "./types";

export interface WorkflowOrchestratorDeps {
  db: typeof defaultDb;
  eventBus: EventBus;
  logger: Logger;
  tmuxManager: {
    isAvailable: () => boolean;
    createSession: (cardId: number, cwd: string) => { sessionName: string; created: boolean };
    startCapture: (sessionName: string, cb: (data: string) => void) => void;
    stopCapture: (sessionName: string) => void;
    killSession: (sessionName: string) => boolean;
  };
  slotAllocator: {
    claimSlot: (repoId: number, cardId: number) => Promise<{ id: number; path: string } | null>;
    releaseSlot: (slotId: number) => Promise<void>;
  };
  workflowLoader: { get: (id: string) => WorkflowDefinition | undefined };
  contextBundler: { buildPrompt: (opts: unknown) => string };
  cardService: CardService;
  stepExecutor: StepExecutor;
  streamTailer: StreamTailer;
  execSync: typeof defaultExecSync;
}

export class WorkflowOrchestrator {
  private deps: WorkflowOrchestratorDeps;

  constructor(deps: Partial<WorkflowOrchestratorDeps> = {}) {
    this.deps = {
      db: defaultDb,
      eventBus: defaultEventBus,
      logger: defaultLogger,
      tmuxManager: defaultTmuxManager,
      slotAllocator: defaultSlotAllocator,
      workflowLoader: defaultWorkflowLoader,
      contextBundler: defaultContextBundler,
      cardService: defaultCardService,
      stepExecutor: defaultStepExecutor,
      streamTailer: defaultStreamTailer,
      execSync: defaultExecSync,
      ...deps,
    };
  }

  /** Execute a full workflow for a card */
  async run(cardId: number): Promise<void> {
    const ctx = await this.initContext(cardId);
    if (!ctx) return;

    try {
      // Create git branch (skip if branchMode is "current")
      if (ctx.card.branchMode !== "current") {
        this.createBranch(ctx);
      }

      // Execute each step in sequence
      for (let i = 0; i < ctx.workflow.steps.length; i++) {
        const step = ctx.workflow.steps[i]!;
        const result = await this.deps.stepExecutor.execute(ctx, step, ctx.previousArtifacts);
        if (!result.passed) {
          await this.handleFailure(ctx);
          return;
        }
      }

      // All steps passed -- run post_steps
      await this.runPostSteps(ctx);

      // Mark workflow completed
      await this.deps.db
        .update(workflowRuns)
        .set({ status: "completed", endedAt: new Date() })
        .where(eq(workflowRuns.id, ctx.workflowRunId));

      await this.deps.db
        .update(cards)
        .set({ currentStepId: null, updatedAt: new Date() })
        .where(eq(cards.id, cardId));

      await this.deps.cardService.markComplete(cardId);
      this.deps.eventBus.emit("workflow:completed", { cardId, status: "completed" });

      this.deps.logger.info(`Workflow completed for card ${cardId}`);
    } catch (err) {
      this.deps.logger.error(`Workflow failed for card ${cardId}:`, err);
      await this.handleFailure(ctx);
    } finally {
      // Cleanup
      clearPendingCallback(ctx.cardId);
      this.deps.streamTailer.stopTailing(ctx.cardId);
      this.deps.tmuxManager.stopCapture(ctx.sessionName);
      const killed = this.deps.tmuxManager.killSession(ctx.sessionName);
      if (killed) {
        await this.deps.cardService.logEvent(
          ctx.cardId,
          "tmux_session_killed",
          `session=${ctx.sessionName}`,
        );
      }
      await this.deps.slotAllocator.releaseSlot(ctx.slotId);
      await this.deps.cardService.logEvent(ctx.cardId, "slot_released", `slotId=${ctx.slotId}`);
    }
  }

  /** Initialize execution context: fetch card, claim slot, create session */
  private async initContext(cardId: number): Promise<WorkflowContext | null> {
    // Fetch card
    const cardRows = await this.deps.db.select().from(cards).where(eq(cards.id, cardId));
    if (cardRows.length === 0) {
      this.deps.logger.error(`Card ${cardId} not found`);
      return null;
    }
    const card = cardRows[0]!;

    if (!card.repoId || !card.workflowId) {
      this.deps.logger.error(`Card ${cardId} missing repoId or workflowId`);
      await this.deps.cardService.updateStatus(cardId, "failed");
      return null;
    }

    // Fetch repo
    const repoRows = await this.deps.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, card.repoId));
    if (repoRows.length === 0) {
      this.deps.logger.error(`Repo ${card.repoId} not found for card ${cardId}`);
      await this.deps.cardService.updateStatus(cardId, "failed");
      return null;
    }
    const repo = repoRows[0]!;

    // Load workflow
    const workflow = this.deps.workflowLoader.get(card.workflowId);
    if (!workflow) {
      this.deps.logger.error(`Workflow "${card.workflowId}" not found for card ${cardId}`);
      await this.deps.cardService.updateStatus(cardId, "failed");
      return null;
    }

    // Check tmux
    if (!this.deps.tmuxManager.isAvailable()) {
      this.deps.logger.error("tmux is not available");
      await this.deps.cardService.updateStatus(cardId, "failed");
      return null;
    }

    // Claim slot
    const slot = await this.deps.slotAllocator.claimSlot(card.repoId, cardId);
    if (!slot) {
      this.deps.logger.warn(`No slot available for card ${cardId}, marking queued`);
      await this.deps.cardService.updateStatus(cardId, "queued");
      return null;
    }

    // Update card to running
    await this.deps.cardService.updateStatus(cardId, "running");

    // Create tmux session
    const { sessionName, created } = this.deps.tmuxManager.createSession(cardId, slot.path);
    if (created) {
      await this.deps.cardService.logEvent(
        cardId,
        "tmux_session_created",
        `session=${sessionName}, cwd=${slot.path}`,
      );
    }

    // Start output capture
    this.deps.tmuxManager.startCapture(sessionName, (output) => {
      this.deps.eventBus.emit("agent:output", { cardId, content: output });
    });

    // Build branch name
    const branch = renderTemplate(workflow.branch_template ?? "agentboard/card-{card_id}", {
      card_id: String(cardId),
      issue: String(card.githubIssueNumber ?? ""),
      issue_title: card.title,
    });

    // Create workflow run record
    const runRows = await this.deps.db
      .insert(workflowRuns)
      .values({
        cardId,
        workflowId: card.workflowId,
        slotId: slot.id,
        tmuxSession: sessionName,
        branch,
        startedAt: new Date(),
      })
      .returning();

    return {
      cardId,
      card,
      repo,
      workflow,
      slotPath: slot.path,
      slotId: slot.id,
      sessionName,
      workflowRunId: runRows[0]!.id,
      branch,
      previousArtifacts: new Map(),
    };
  }

  /** Create a git branch in the slot directory */
  private createBranch(ctx: WorkflowContext): void {
    try {
      this.deps.execSync(`git checkout -b ${ctx.branch}`, {
        cwd: ctx.slotPath,
        stdio: "ignore",
      });
      this.deps.logger.info(`Created branch ${ctx.branch} in ${ctx.slotPath}`);
    } catch {
      // Branch may already exist -- try checking it out
      try {
        this.deps.execSync(`git checkout ${ctx.branch}`, {
          cwd: ctx.slotPath,
          stdio: "ignore",
        });
      } catch (err) {
        this.deps.logger.error(`Failed to create/checkout branch ${ctx.branch}:`, err);
      }
    }
  }

  /** Execute post-workflow steps (create PR, update labels) */
  private async runPostSteps(ctx: WorkflowContext): Promise<void> {
    if (!ctx.workflow.post_steps || !(ctx.workflow.post_steps as { create_pr?: boolean }).create_pr)
      return;

    const postSteps = ctx.workflow.post_steps as {
      create_pr?: boolean;
      pr_title_template?: string;
    };
    const prTitle = renderTemplate(postSteps.pr_title_template ?? "agentboard: {card_title}", {
      issue: String(ctx.card.githubIssueNumber ?? ""),
      issue_title: ctx.card.title,
      card_title: ctx.card.title,
      card_id: String(ctx.cardId),
    });

    // Push branch and create PR via git/gh CLI
    try {
      this.deps.execSync(`git push -u origin ${ctx.branch}`, {
        cwd: ctx.slotPath,
        stdio: "ignore",
      });

      const base = (ctx.repo as { defaultBranch?: string }).defaultBranch ?? "main";
      const prUrl = this.deps.execSync(
        `gh pr create --title ${shellEscape(prTitle)} --body "Automated by AgentBoard" --base ${base} --head ${ctx.branch}`,
        { cwd: ctx.slotPath, encoding: "utf-8" },
      ) as unknown as string;

      this.deps.logger.info(`PR created for card ${ctx.cardId}: ${prUrl.trim()}`);
    } catch (err) {
      this.deps.logger.error(`Failed to create PR for card ${ctx.cardId}:`, err);
    }
  }

  /** Handle workflow failure: update statuses */
  private async handleFailure(ctx: WorkflowContext): Promise<void> {
    await this.deps.db
      .update(workflowRuns)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(workflowRuns.id, ctx.workflowRunId));

    await this.deps.cardService.updateStatus(ctx.cardId, "failed");
    this.deps.eventBus.emit("workflow:completed", { cardId: ctx.cardId, status: "failed" });
  }
}

export const workflowOrchestrator = new WorkflowOrchestrator();
