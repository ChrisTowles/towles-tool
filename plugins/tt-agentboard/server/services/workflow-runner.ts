import { db as defaultDb } from "../db";
import { cards, workflowRuns, stepRuns, repositories } from "../db/schema";
import { eq } from "drizzle-orm";
import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync as defaultExecSync } from "node:child_process";
import { tmuxManager as defaultTmuxManager } from "./tmux-manager";
import { slotAllocator as defaultSlotAllocator } from "./slot-allocator";
import { workflowLoader as defaultWorkflowLoader } from "./workflow-loader";
import { contextBundler as defaultContextBundler } from "./context-bundler";
import type { WorkflowDefinition, WorkflowStep } from "./workflow-loader";
import { eventBus as defaultEventBus } from "../utils/event-bus";
import { logger as defaultLogger } from "../utils/logger";
import { writeHooks as defaultWriteHooks } from "../utils/hook-writer";
import {
  buildStreamingCommand,
  checkPassCondition,
  renderTemplate,
  shellEscape,
} from "../utils/workflow-helpers";
import { logCardEvent as defaultLogCardEvent } from "../utils/card-events";
import { streamTailer as defaultStreamTailer } from "./stream-tailer";

interface RunContext {
  cardId: number;
  card: typeof cards.$inferSelect;
  repo: typeof repositories.$inferSelect;
  workflow: WorkflowDefinition;
  slotPath: string;
  slotId: number;
  sessionName: string;
  workflowRunId: number;
  branch: string;
  previousArtifacts: Map<string, string>;
}

/** Pending step completion callbacks, keyed by cardId */
const pendingStepCallbacks = new Map<number, () => void>();

/** Called by the step-complete API endpoint to resolve the pending Promise */
export function resolveStepComplete(cardId: number): boolean {
  const resolve = pendingStepCallbacks.get(cardId);
  if (resolve) {
    resolve();
    pendingStepCallbacks.delete(cardId);
    return true;
  }
  return false;
}

export interface WorkflowRunnerDeps {
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
  };
  workflowLoader: { get: (id: string) => WorkflowDefinition | undefined };
  contextBundler: { buildPrompt: (opts: unknown) => string };
  writeHooks: typeof defaultWriteHooks;
  logCardEvent: typeof defaultLogCardEvent;
  streamTailer: {
    startTailing: (cardId: number, logFilePath: string) => Promise<void>;
    stopTailing: (cardId: number) => void;
  };
  execSync: typeof defaultExecSync;
  existsSync: typeof defaultExistsSync;
  readFileSync: typeof defaultReadFileSync;
}

export class WorkflowRunner {
  private port: number;
  private deps: WorkflowRunnerDeps;

  constructor(port = 4200, deps: Partial<WorkflowRunnerDeps> = {}) {
    this.port = port;
    this.deps = {
      db: defaultDb,
      eventBus: defaultEventBus,
      logger: defaultLogger,
      tmuxManager: defaultTmuxManager,
      slotAllocator: defaultSlotAllocator,
      workflowLoader: defaultWorkflowLoader,
      contextBundler: defaultContextBundler,
      writeHooks: defaultWriteHooks,
      logCardEvent: defaultLogCardEvent,
      streamTailer: defaultStreamTailer,
      execSync: defaultExecSync,
      existsSync: defaultExistsSync,
      readFileSync: defaultReadFileSync,
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
        const passed = await this.executeStep(ctx, step, i);
        if (!passed) {
          await this.handleFailure(ctx);
          return;
        }
      }

      // All steps passed — run post_steps
      await this.runPostSteps(ctx);

      // Mark workflow completed
      await this.deps.db
        .update(workflowRuns)
        .set({ status: "completed", endedAt: new Date() })
        .where(eq(workflowRuns.id, ctx.workflowRunId));

      await this.deps.db
        .update(cards)
        .set({
          column: "review",
          status: "review_ready",
          currentStepId: null,
          updatedAt: new Date(),
        })
        .where(eq(cards.id, cardId));

      this.deps.eventBus.emit("card:moved", {
        cardId,
        fromColumn: "in_progress",
        toColumn: "review",
      });
      this.deps.eventBus.emit("card:status-changed", { cardId, status: "review_ready" });
      this.deps.eventBus.emit("workflow:completed", { cardId, status: "completed" });

      this.deps.logger.info(`Workflow completed for card ${cardId}`);
    } catch (err) {
      this.deps.logger.error(`Workflow failed for card ${cardId}:`, err);
      await this.handleFailure(ctx);
    } finally {
      // Cleanup
      pendingStepCallbacks.delete(ctx.cardId);
      this.deps.streamTailer.stopTailing(ctx.cardId);
      this.deps.tmuxManager.stopCapture(ctx.sessionName);
      const killed = this.deps.tmuxManager.killSession(ctx.sessionName);
      if (killed) {
        await this.deps.logCardEvent(
          ctx.cardId,
          "tmux_session_killed",
          `session=${ctx.sessionName}`,
        );
      }
      await this.deps.slotAllocator.releaseSlot(ctx.slotId);
      await this.deps.logCardEvent(ctx.cardId, "slot_released", `slotId=${ctx.slotId}`);
    }
  }

  /** Initialize execution context: fetch card, claim slot, create session */
  private async initContext(cardId: number): Promise<RunContext | null> {
    // Fetch card
    const cardRows = await this.deps.db.select().from(cards).where(eq(cards.id, cardId));
    if (cardRows.length === 0) {
      this.deps.logger.error(`Card ${cardId} not found`);
      return null;
    }
    const card = cardRows[0]!;

    if (!card.repoId || !card.workflowId) {
      this.deps.logger.error(`Card ${cardId} missing repoId or workflowId`);
      await this.updateCardStatus(cardId, "failed");
      return null;
    }

    // Fetch repo
    const repoRows = await this.deps.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, card.repoId));
    if (repoRows.length === 0) {
      this.deps.logger.error(`Repo ${card.repoId} not found for card ${cardId}`);
      await this.updateCardStatus(cardId, "failed");
      return null;
    }
    const repo = repoRows[0]!;

    // Load workflow
    const workflow = this.deps.workflowLoader.get(card.workflowId);
    if (!workflow) {
      this.deps.logger.error(`Workflow "${card.workflowId}" not found for card ${cardId}`);
      await this.updateCardStatus(cardId, "failed");
      return null;
    }

    // Check tmux
    if (!this.deps.tmuxManager.isAvailable()) {
      this.deps.logger.error("tmux is not available");
      await this.updateCardStatus(cardId, "failed");
      return null;
    }

    // Claim slot
    const slot = await this.deps.slotAllocator.claimSlot(card.repoId, cardId);
    if (!slot) {
      this.deps.logger.warn(`No slot available for card ${cardId}, marking queued`);
      await this.updateCardStatus(cardId, "queued");
      return null;
    }

    // Update card to running
    await this.updateCardStatus(cardId, "running");

    // Create tmux session
    const { sessionName, created } = this.deps.tmuxManager.createSession(cardId, slot.path);
    if (created) {
      await this.deps.logCardEvent(
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
  private createBranch(ctx: RunContext): void {
    try {
      this.deps.execSync(`git checkout -b ${ctx.branch}`, {
        cwd: ctx.slotPath,
        stdio: "ignore",
      });
      this.deps.logger.info(`Created branch ${ctx.branch} in ${ctx.slotPath}`);
    } catch {
      // Branch may already exist — try checking it out
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

  /** Execute a single workflow step: write Stop hook, send prompt, wait for callback */
  private async executeStep(
    ctx: RunContext,
    step: WorkflowStep,
    stepIndex: number,
  ): Promise<boolean> {
    const maxRetries = step.max_retries ?? 0;

    for (let retry = 0; retry <= maxRetries; retry++) {
      // Create step run record
      const stepRunRows = await this.deps.db
        .insert(stepRuns)
        .values({
          workflowRunId: ctx.workflowRunId,
          stepId: step.id,
          startedAt: new Date(),
          retryNumber: retry,
        })
        .returning();
      const stepRunId = stepRunRows[0]!.id;

      // Update card current step
      await this.deps.db
        .update(cards)
        .set({ currentStepId: step.id, retryCount: retry, updatedAt: new Date() })
        .where(eq(cards.id, ctx.cardId));

      this.deps.eventBus.emit("step:started", { cardId: ctx.cardId, stepId: step.id });
      await this.deps.logCardEvent(ctx.cardId, "step_started", `stepId=${step.id}, retry=${retry}`);

      // Write Stop hook for this step — points to step-complete callback
      this.deps.writeHooks(ctx.slotPath, ctx.cardId, this.port, "step-complete");
      await this.deps.logCardEvent(
        ctx.cardId,
        "hooks_written",
        `endpoint=step-complete, step=${step.id}`,
      );

      // Build prompt
      const prompt = await this.buildStepPrompt(ctx, step);

      const args: string[] = ["--dangerously-skip-permissions"];
      args.push("--max-turns", "50");
      if (step.model) args.push("--model", step.model);
      args.push("-p", shellEscape(prompt));

      const logFilePath = join(ctx.slotPath, ".claude-stream.ndjson");
      const command = buildStreamingCommand(args, logFilePath);

      this.deps.tmuxManager.sendCommand(ctx.sessionName, command);

      // Start tailing the stream-json output for structured activity events
      await this.deps.streamTailer.startTailing(ctx.cardId, logFilePath);

      // Wait for Stop hook callback (step-complete endpoint resolves this)
      const completed = await this.waitForStepComplete(ctx.cardId);

      if (!completed) {
        this.deps.logger.warn(`Step ${step.id} timed out for card ${ctx.cardId}`);
        await this.deps.logCardEvent(
          ctx.cardId,
          "step_failed",
          `stepId=${step.id}, reason=timeout, retry=${retry}`,
        );
        await this.deps.db
          .update(stepRuns)
          .set({ status: "failed", endedAt: new Date() })
          .where(eq(stepRuns.id, stepRunId));

        this.deps.eventBus.emit("step:failed", {
          cardId: ctx.cardId,
          stepId: step.id,
          retryNumber: retry,
        });

        if (retry < maxRetries) continue;
        return false;
      }

      // Resolve artifact path
      const artifactPath = resolve(
        ctx.slotPath,
        renderTemplate(step.artifact, {
          issue: String(ctx.card.githubIssueNumber ?? ""),
          issue_title: ctx.card.title,
          card_id: String(ctx.cardId),
        }),
      );

      // Check for artifact after hook fired
      if (!this.deps.existsSync(artifactPath)) {
        this.deps.logger.warn(
          `Artifact not found at ${artifactPath} after step ${step.id} completed`,
        );
        await this.deps.logCardEvent(
          ctx.cardId,
          "step_failed",
          `stepId=${step.id}, reason=artifact_missing, retry=${retry}`,
        );
        await this.deps.db
          .update(stepRuns)
          .set({ status: "failed", endedAt: new Date() })
          .where(eq(stepRuns.id, stepRunId));

        this.deps.eventBus.emit("step:failed", {
          cardId: ctx.cardId,
          stepId: step.id,
          retryNumber: retry,
        });

        if (retry < maxRetries) continue;
        return false;
      }

      // Read artifact content
      const artifactContent = this.deps.readFileSync(artifactPath, "utf-8");
      ctx.previousArtifacts.set(step.id, artifactContent);

      // Check pass condition if defined
      if (step.pass_condition) {
        const passed = checkPassCondition(step.pass_condition, artifactContent);
        if (!passed) {
          await this.deps.logCardEvent(
            ctx.cardId,
            "step_failed",
            `stepId=${step.id}, reason=pass_condition, retry=${retry}`,
          );
          await this.deps.db
            .update(stepRuns)
            .set({ status: "failed", endedAt: new Date(), artifactPath })
            .where(eq(stepRuns.id, stepRunId));

          this.deps.eventBus.emit("step:failed", {
            cardId: ctx.cardId,
            stepId: step.id,
            retryNumber: retry,
          });

          // Handle on_fail goto directive
          if (step.on_fail?.startsWith("goto:") && retry < maxRetries) {
            const targetStepId = step.on_fail.slice(5);
            const targetIndex = ctx.workflow.steps.findIndex((s) => s.id === targetStepId);
            if (targetIndex >= 0) {
              this.deps.logger.info(`Step ${step.id} failed, retrying from ${targetStepId}`);
              continue;
            }
          }

          if (retry < maxRetries) continue;
          return false;
        }
      }

      // Step passed
      await this.deps.db
        .update(stepRuns)
        .set({ status: "completed", endedAt: new Date(), artifactPath })
        .where(eq(stepRuns.id, stepRunId));

      await this.deps.db
        .update(cards)
        .set({ currentStepId: `${step.id}:done`, updatedAt: new Date() })
        .where(eq(cards.id, ctx.cardId));

      await this.deps.logCardEvent(ctx.cardId, "step_completed", `stepId=${step.id}`);
      this.deps.eventBus.emit("step:completed", {
        cardId: ctx.cardId,
        stepId: step.id,
        passed: true,
      });

      this.deps.logger.info(`Step ${step.id} completed for card ${ctx.cardId}`);
      return true;
    }

    return false;
  }

  /** Wait for the step-complete callback, with timeout */
  private waitForStepComplete(cardId: number, timeoutMs: number = 600_000): Promise<boolean> {
    return new Promise((resolvePromise) => {
      const timeout = setTimeout(() => {
        pendingStepCallbacks.delete(cardId);
        resolvePromise(false);
      }, timeoutMs);

      pendingStepCallbacks.set(cardId, () => {
        clearTimeout(timeout);
        resolvePromise(true);
      });
    });
  }

  /** Build the prompt for a step using the context bundler */
  private buildStepPrompt(ctx: RunContext, step: WorkflowStep): string {
    return this.deps.contextBundler.buildPrompt({
      step,
      card: ctx.card,
      slotPath: ctx.slotPath,
      issueNumber: ctx.card.githubIssueNumber ?? undefined,
      issueTitle: ctx.card.title,
      previousArtifacts: ctx.previousArtifacts,
    });
  }

  /** Execute post-workflow steps (create PR, update labels) */
  private async runPostSteps(ctx: RunContext): Promise<void> {
    if (!ctx.workflow.post_steps?.create_pr) return;

    const prTitle = renderTemplate(
      ctx.workflow.post_steps.pr_title_template ?? "agentboard: {card_title}",
      {
        issue: String(ctx.card.githubIssueNumber ?? ""),
        issue_title: ctx.card.title,
        card_title: ctx.card.title,
        card_id: String(ctx.cardId),
      },
    );

    // Push branch and create PR via git/gh CLI
    try {
      this.deps.execSync(`git push -u origin ${ctx.branch}`, {
        cwd: ctx.slotPath,
        stdio: "ignore",
      });

      const base = ctx.repo.defaultBranch ?? "main";
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
  private async handleFailure(ctx: RunContext): Promise<void> {
    await this.deps.db
      .update(workflowRuns)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(workflowRuns.id, ctx.workflowRunId));

    await this.updateCardStatus(ctx.cardId, "failed");
    this.deps.eventBus.emit("workflow:completed", { cardId: ctx.cardId, status: "failed" });
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

export const workflowRunner = new WorkflowRunner();
