import { db } from "../db";
import { cards, workflowRuns, stepRuns, repositories } from "../db/schema";
import { eq } from "drizzle-orm";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import { watch } from "chokidar";
import { tmuxManager } from "./tmux-manager";
import { slotAllocator } from "./slot-allocator";
import { workflowLoader } from "./workflow-loader";
import { contextBundler } from "./context-bundler";
import type { WorkflowDefinition, WorkflowStep } from "./workflow-loader";
import { eventBus } from "../utils/event-bus";
import { logger } from "../utils/logger";

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

export class WorkflowRunner {
  /** Execute a full workflow for a card */
  async run(cardId: number): Promise<void> {
    const ctx = await this.initContext(cardId);
    if (!ctx) return;

    try {
      // Create git branch
      this.createBranch(ctx);

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
      await db
        .update(workflowRuns)
        .set({ status: "completed", endedAt: new Date() })
        .where(eq(workflowRuns.id, ctx.workflowRunId));

      await db
        .update(cards)
        .set({ column: "review", status: "review_ready", updatedAt: new Date() })
        .where(eq(cards.id, cardId));

      eventBus.emit("card:moved", { cardId, fromColumn: "in_progress", toColumn: "review" });
      eventBus.emit("card:status-changed", { cardId, status: "review_ready" });
      eventBus.emit("workflow:completed", { cardId, status: "completed" });

      logger.info(`Workflow completed for card ${cardId}`);
    } catch (err) {
      logger.error(`Workflow failed for card ${cardId}:`, err);
      await this.handleFailure(ctx);
    } finally {
      // Cleanup
      tmuxManager.stopCapture(ctx.sessionName);
      tmuxManager.killSession(ctx.sessionName);
      await slotAllocator.releaseSlot(ctx.slotId);
    }
  }

  /** Initialize execution context: fetch card, claim slot, create session */
  private async initContext(cardId: number): Promise<RunContext | null> {
    // Fetch card
    const cardRows = await db.select().from(cards).where(eq(cards.id, cardId));
    if (cardRows.length === 0) {
      logger.error(`Card ${cardId} not found`);
      return null;
    }
    const card = cardRows[0]!;

    if (!card.repoId || !card.workflowId) {
      logger.error(`Card ${cardId} missing repoId or workflowId`);
      await this.updateCardStatus(cardId, "failed");
      return null;
    }

    // Fetch repo
    const repoRows = await db.select().from(repositories).where(eq(repositories.id, card.repoId));
    if (repoRows.length === 0) {
      logger.error(`Repo ${card.repoId} not found for card ${cardId}`);
      await this.updateCardStatus(cardId, "failed");
      return null;
    }
    const repo = repoRows[0]!;

    // Load workflow
    const workflow = workflowLoader.get(card.workflowId);
    if (!workflow) {
      logger.error(`Workflow "${card.workflowId}" not found for card ${cardId}`);
      await this.updateCardStatus(cardId, "failed");
      return null;
    }

    // Check tmux
    if (!tmuxManager.isAvailable()) {
      logger.error("tmux is not available");
      await this.updateCardStatus(cardId, "failed");
      return null;
    }

    // Claim slot
    const slot = await slotAllocator.claimSlot(card.repoId, cardId);
    if (!slot) {
      logger.warn(`No slot available for card ${cardId}, marking queued`);
      await this.updateCardStatus(cardId, "queued");
      return null;
    }

    // Update card to running
    await this.updateCardStatus(cardId, "running");

    // Create tmux session
    const sessionName = tmuxManager.createSession(cardId, slot.path);

    // Start output capture
    tmuxManager.startCapture(sessionName, (output) => {
      eventBus.emit("agent:output", { cardId, content: output });
    });

    // Build branch name
    const branch = this.renderTemplate(workflow.branch_template ?? "agentboard/card-{card_id}", {
      card_id: String(cardId),
      issue: String(card.githubIssueNumber ?? ""),
      issue_title: card.title,
    });

    // Create workflow run record
    const runRows = await db
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
      execSync(`git checkout -b ${ctx.branch}`, {
        cwd: ctx.slotPath,
        stdio: "ignore",
      });
      logger.info(`Created branch ${ctx.branch} in ${ctx.slotPath}`);
    } catch {
      // Branch may already exist — try checking it out
      try {
        execSync(`git checkout ${ctx.branch}`, {
          cwd: ctx.slotPath,
          stdio: "ignore",
        });
      } catch (err) {
        logger.error(`Failed to create/checkout branch ${ctx.branch}:`, err);
      }
    }
  }

  /** Execute a single workflow step: send prompt, wait for artifact, check condition */
  private async executeStep(
    ctx: RunContext,
    step: WorkflowStep,
    stepIndex: number,
  ): Promise<boolean> {
    const maxRetries = step.max_retries ?? 0;

    for (let retry = 0; retry <= maxRetries; retry++) {
      // Create step run record
      const stepRunRows = await db
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
      await db
        .update(cards)
        .set({ currentStepId: step.id, retryCount: retry, updatedAt: new Date() })
        .where(eq(cards.id, ctx.cardId));

      eventBus.emit("step:started", { cardId: ctx.cardId, stepId: step.id });

      // Build prompt
      const prompt = await this.buildStepPrompt(ctx, step);

      // Build Claude Code command
      const modelFlag = step.model ? `--model ${step.model}` : "";
      const command = `claude --message ${this.shellEscape(prompt)} --dangerously-skip-permissions ${modelFlag}`.trim();

      // Send command to tmux
      tmuxManager.sendCommand(ctx.sessionName, command);

      // Resolve artifact path
      const artifactPath = resolve(
        ctx.slotPath,
        this.renderTemplate(step.artifact, {
          issue: String(ctx.card.githubIssueNumber ?? ""),
          issue_title: ctx.card.title,
          card_id: String(ctx.cardId),
        }),
      );

      // Wait for artifact to appear
      const found = await this.waitForArtifact(artifactPath);

      if (!found) {
        logger.warn(`Artifact not found for step ${step.id}, card ${ctx.cardId}`);
        await db
          .update(stepRuns)
          .set({ status: "failed", endedAt: new Date() })
          .where(eq(stepRuns.id, stepRunId));

        eventBus.emit("step:failed", {
          cardId: ctx.cardId,
          stepId: step.id,
          retryNumber: retry,
        });

        if (retry < maxRetries) continue;
        return false;
      }

      // Read artifact content
      const artifactContent = readFileSync(artifactPath, "utf-8");
      ctx.previousArtifacts.set(step.id, artifactContent);

      // Check pass condition if defined
      if (step.pass_condition) {
        const passed = this.checkPassCondition(step.pass_condition, artifactContent);
        if (!passed) {
          await db
            .update(stepRuns)
            .set({
              status: "failed",
              endedAt: new Date(),
              artifactPath,
            })
            .where(eq(stepRuns.id, stepRunId));

          eventBus.emit("step:failed", {
            cardId: ctx.cardId,
            stepId: step.id,
            retryNumber: retry,
          });

          // Handle on_fail goto directive
          if (step.on_fail?.startsWith("goto:") && retry < maxRetries) {
            const targetStepId = step.on_fail.slice(5);
            const targetIndex = ctx.workflow.steps.findIndex((s) => s.id === targetStepId);
            if (targetIndex >= 0) {
              logger.info(`Step ${step.id} failed, retrying from ${targetStepId}`);
              // Re-execute from target step (handled by caller via retry)
              continue;
            }
          }

          if (retry < maxRetries) continue;
          return false;
        }
      }

      // Step passed
      await db
        .update(stepRuns)
        .set({
          status: "completed",
          endedAt: new Date(),
          artifactPath,
        })
        .where(eq(stepRuns.id, stepRunId));

      eventBus.emit("step:completed", {
        cardId: ctx.cardId,
        stepId: step.id,
        passed: true,
      });

      logger.info(`Step ${step.id} completed for card ${ctx.cardId}`);
      return true;
    }

    return false;
  }

  /** Build the prompt for a step using the context bundler */
  private buildStepPrompt(ctx: RunContext, step: WorkflowStep): string {
    return contextBundler.buildPrompt({
      step,
      card: ctx.card,
      slotPath: ctx.slotPath,
      issueNumber: ctx.card.githubIssueNumber ?? undefined,
      issueTitle: ctx.card.title,
      previousArtifacts: ctx.previousArtifacts,
    });
  }

  /** Wait for an artifact file to appear, with timeout */
  private waitForArtifact(path: string, timeoutMs: number = 600_000): Promise<boolean> {
    return new Promise((resolvePromise) => {
      if (existsSync(path)) {
        resolvePromise(true);
        return;
      }

      const dir = dirname(path);
      const watcher = watch(dir, { ignoreInitial: false });
      const timeout = setTimeout(() => {
        watcher.close();
        resolvePromise(false);
      }, timeoutMs);

      watcher.on("add", (addedPath) => {
        if (resolve(addedPath) === resolve(path)) {
          clearTimeout(timeout);
          watcher.close();
          resolvePromise(true);
        }
      });
    });
  }

  /** Check if artifact content satisfies the pass condition */
  private checkPassCondition(condition: string, content: string): boolean {
    if (condition.startsWith("first_line_equals:")) {
      const expected = condition.slice("first_line_equals:".length);
      const firstLine = content.split("\n")[0]?.trim() ?? "";
      return firstLine === expected;
    }

    if (condition.startsWith("contains:")) {
      const expected = condition.slice("contains:".length);
      return content.includes(expected);
    }

    logger.warn(`Unknown pass_condition format: ${condition}`);
    return true;
  }

  /** Execute post-workflow steps (create PR, update labels) */
  private async runPostSteps(ctx: RunContext): Promise<void> {
    if (!ctx.workflow.post_steps?.create_pr) return;

    const prTitle = this.renderTemplate(
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
      execSync(`git push -u origin ${ctx.branch}`, {
        cwd: ctx.slotPath,
        stdio: "ignore",
      });

      const base = ctx.repo.defaultBranch ?? "main";
      const prUrl = execSync(
        `gh pr create --title ${this.shellEscape(prTitle)} --body "Automated by AgentBoard" --base ${base} --head ${ctx.branch}`,
        { cwd: ctx.slotPath, encoding: "utf-8" },
      ).trim();

      logger.info(`PR created for card ${ctx.cardId}: ${prUrl}`);
    } catch (err) {
      logger.error(`Failed to create PR for card ${ctx.cardId}:`, err);
    }
  }

  /** Handle workflow failure: update statuses */
  private async handleFailure(ctx: RunContext): Promise<void> {
    await db
      .update(workflowRuns)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(workflowRuns.id, ctx.workflowRunId));

    await this.updateCardStatus(ctx.cardId, "failed");
    eventBus.emit("workflow:completed", { cardId: ctx.cardId, status: "failed" });
  }

  private async updateCardStatus(
    cardId: number,
    status: "idle" | "queued" | "running" | "waiting_input" | "review_ready" | "done" | "failed" | "blocked",
  ): Promise<void> {
    await db
      .update(cards)
      .set({ status, updatedAt: new Date() })
      .where(eq(cards.id, cardId));

    eventBus.emit("card:status-changed", { cardId, status });
  }

  /** Replace {variable} placeholders in a template string */
  private renderTemplate(template: string, vars: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replaceAll(`{${key}}`, value);
    }
    return result;
  }

  /** Escape a string for safe use in shell commands */
  private shellEscape(str: string): string {
    return `'${str.replace(/'/g, "'\\''")}'`;
  }
}

export const workflowRunner = new WorkflowRunner();
