import { stepRuns, cards } from "../../shared/db/schema";
import { eq } from "drizzle-orm";
import { resolve, join } from "node:path";
import { db as defaultDb } from "../../shared/db";
import { eventBus as defaultEventBus } from "../../shared/event-bus";
import { logger as defaultLogger } from "../../utils/logger";
import { tmuxManager as defaultTmuxManager } from "../infra/tmux-manager";
import { writeHooks as defaultWriteHooks } from "../infra/hook-writer";
import { contextBundler as defaultContextBundler } from "./context-bundler";
import { streamTailer as defaultStreamTailer } from "../infra/stream-tailer";
import { cardService as defaultCardService } from "../cards/card-service";
import type { CardService } from "../cards/card-service";
import type { WorkflowStep } from "./workflow-loader";
import {
  buildStreamingCommand,
  checkPassCondition,
  renderTemplate,
  shellEscape,
} from "./workflow-helpers";
import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync } from "node:fs";

export interface WorkflowContext {
  cardId: number;
  card: { id: number; githubIssueNumber: number | null; title: string; [key: string]: unknown };
  repo: { id: number; [key: string]: unknown };
  workflow: {
    steps: WorkflowStep[];
    branch_template?: string;
    post_steps?: unknown;
    [key: string]: unknown;
  };
  slotPath: string;
  slotId: number;
  sessionName: string;
  workflowRunId: number;
  branch: string;
  previousArtifacts: Map<string, string>;
}

export interface StepResult {
  passed: boolean;
  artifact?: string;
}

/** Pending step completion callbacks, keyed by cardId */
const pendingStepCallbacks = new Map<number, () => void>();

/** Called by the step-complete API endpoint to resolve the pending Promise */
export function resolveStepComplete(cardId: number): boolean {
  const cb = pendingStepCallbacks.get(cardId);
  if (cb) {
    cb();
    pendingStepCallbacks.delete(cardId);
    return true;
  }
  return false;
}

/** Clear a pending callback (used during cleanup) */
export function clearPendingCallback(cardId: number): void {
  pendingStepCallbacks.delete(cardId);
}

export interface StepExecutorDeps {
  db: typeof defaultDb;
  eventBus: { emit: (event: string, ...args: unknown[]) => boolean | void };
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  tmuxManager: {
    sendCommand: (sessionName: string, command: string) => void;
  };
  contextBundler: { buildPrompt: (opts: unknown) => string };
  writeHooks: typeof defaultWriteHooks;
  cardService: CardService;
  streamTailer: {
    startTailing: (cardId: number, logFilePath: string) => Promise<void>;
    stopTailing: (cardId: number) => void;
  };
  existsSync: typeof defaultExistsSync;
  readFileSync: typeof defaultReadFileSync;
}

export class StepExecutor {
  private port: number;
  private deps: StepExecutorDeps;

  constructor(port = 4200, deps: Partial<StepExecutorDeps> = {}) {
    this.port = port;
    this.deps = {
      db: defaultDb,
      eventBus: defaultEventBus,
      logger: defaultLogger,
      tmuxManager: defaultTmuxManager,
      contextBundler: defaultContextBundler,
      writeHooks: defaultWriteHooks,
      cardService: defaultCardService,
      streamTailer: defaultStreamTailer,
      existsSync: defaultExistsSync,
      readFileSync: defaultReadFileSync,
      ...deps,
    };
  }

  /** Execute a single workflow step with retries. Returns StepResult. */
  async execute(
    ctx: WorkflowContext,
    step: WorkflowStep,
    previousArtifacts: Map<string, string>,
  ): Promise<StepResult> {
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
      await this.deps.cardService.logEvent(
        ctx.cardId,
        "step_started",
        `stepId=${step.id}, retry=${retry}`,
      );

      // Write Stop hook for this step
      this.deps.writeHooks(ctx.slotPath, ctx.cardId, this.port, "step-complete");
      await this.deps.cardService.logEvent(
        ctx.cardId,
        "hooks_written",
        `endpoint=step-complete, step=${step.id}`,
      );

      // Build prompt
      const prompt = this.buildStepPrompt(ctx, step);

      const args: string[] = ["--dangerously-skip-permissions"];
      args.push("--max-turns", "50");
      if (step.model) args.push("--model", step.model);
      args.push("-p", shellEscape(prompt));

      const logFilePath = join(ctx.slotPath, ".claude-stream.ndjson");
      const command = buildStreamingCommand(args, logFilePath);

      this.deps.tmuxManager.sendCommand(ctx.sessionName, command);

      // Start tailing the stream-json output
      await this.deps.streamTailer.startTailing(ctx.cardId, logFilePath);

      // Wait for Stop hook callback
      const completed = await this.waitForStepComplete(ctx.cardId);

      if (!completed) {
        this.deps.logger.warn(`Step ${step.id} timed out for card ${ctx.cardId}`);
        await this.deps.cardService.logEvent(
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
        return { passed: false };
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
        await this.deps.cardService.logEvent(
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
        return { passed: false };
      }

      // Read artifact content
      const artifactContent = this.deps.readFileSync(artifactPath, "utf-8");
      previousArtifacts.set(step.id, artifactContent);

      // Check pass condition if defined
      if (step.pass_condition) {
        const passed = checkPassCondition(step.pass_condition, artifactContent);
        if (!passed) {
          await this.deps.cardService.logEvent(
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

          if (retry < maxRetries) continue;
          return { passed: false };
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

      await this.deps.cardService.logEvent(ctx.cardId, "step_completed", `stepId=${step.id}`);
      this.deps.eventBus.emit("step:completed", {
        cardId: ctx.cardId,
        stepId: step.id,
        passed: true,
      });

      this.deps.logger.info(`Step ${step.id} completed for card ${ctx.cardId}`);
      return { passed: true, artifact: artifactContent };
    }

    return { passed: false };
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
  private buildStepPrompt(ctx: WorkflowContext, step: WorkflowStep): string {
    return this.deps.contextBundler.buildPrompt({
      step,
      card: ctx.card,
      slotPath: ctx.slotPath,
      issueNumber: ctx.card.githubIssueNumber ?? undefined,
      issueTitle: ctx.card.title,
      previousArtifacts: ctx.previousArtifacts,
    });
  }
}

export const stepExecutor = new StepExecutor();
