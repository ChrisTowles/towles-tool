import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkflowStep } from "./workflow-loader";
import type { cards } from "../db/schema";
import { logger } from "../utils/logger";

interface BuildPromptOptions {
  step: WorkflowStep;
  card: typeof cards.$inferSelect;
  slotPath: string;
  issueNumber?: number;
  issueTitle?: string;
  previousArtifacts: Map<string, string>;
  dependencyDiffs?: string[];
}

export class ContextBundler {
  /**
   * Assemble the full prompt for a workflow step.
   * Reads the prompt template, replaces variables, appends context.
   */
  buildPrompt(options: BuildPromptOptions): string {
    const { step, card, slotPath, issueNumber, issueTitle, previousArtifacts, dependencyDiffs } =
      options;

    const templatePath = resolve(slotPath, step.prompt_template);

    let template: string;
    if (existsSync(templatePath)) {
      template = readFileSync(templatePath, "utf-8");
    } else {
      logger.warn(`Prompt template not found: ${templatePath}, using card description`);
      template = card.description ?? card.title;
    }

    // Replace template variables
    template = template
      .replaceAll("{issue}", String(issueNumber ?? ""))
      .replaceAll("{issue_title}", issueTitle ?? "")
      .replaceAll("{card_title}", card.title)
      .replaceAll("{card_description}", card.description ?? "")
      .replaceAll("{card_id}", String(card.id));

    // Append previous step artifacts as context
    for (const [stepId, content] of previousArtifacts) {
      template += `\n\n## Output from ${stepId} step:\n${content}`;
    }

    // Append dependency diffs if available
    if (dependencyDiffs?.length) {
      template += `\n\n## Changes from dependency cards:\n${dependencyDiffs.join("\n---\n")}`;
    }

    // Append CLAUDE.md if present in the repo
    const claudeMdPath = resolve(slotPath, "CLAUDE.md");
    if (existsSync(claudeMdPath)) {
      template += `\n\n## Project CLAUDE.md:\n${readFileSync(claudeMdPath, "utf-8")}`;
    }

    return template;
  }
}

export const contextBundler = new ContextBundler();
