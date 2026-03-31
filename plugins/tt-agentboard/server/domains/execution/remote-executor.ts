import { db as defaultDb } from "../../shared/db";
import { cards, workflowRuns } from "../../shared/db/schema";
import { eq } from "drizzle-orm";
import { eventBus as defaultEventBus } from "../../shared/event-bus";
import { logger as defaultLogger } from "../../utils/logger";
import { cardService as defaultCardService } from "../cards/card-service";
import { ptyExec as defaultPtyExec } from "../infra/pty-exec";
import type { PtyExecFn } from "../infra/pty-exec";
import type { CardService } from "../cards/card-service";
import type { Logger, EventBus } from "./types";

export interface RemoteExecutorDeps {
  db: typeof defaultDb;
  eventBus: EventBus;
  logger: Logger;
  cardService: CardService;
  exec: PtyExecFn;
}

const SESSION_ID_RE = /Resume with: claude --teleport (session_\w+)/;
const SESSION_URL_RE = /View: (https:\/\/claude\.ai\/code\/\S+)/;

export class RemoteExecutor {
  private deps: RemoteExecutorDeps;

  constructor(deps: Partial<RemoteExecutorDeps> = {}) {
    this.deps = {
      db: defaultDb,
      eventBus: defaultEventBus,
      logger: defaultLogger,
      cardService: defaultCardService,
      exec: defaultPtyExec,
      ...deps,
    };
  }

  async startExecution(cardId: number): Promise<void> {
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

    await this.deps.cardService.updateStatus(cardId, "running");

    const prompt = card.description ?? card.title;

    let stdout: string;
    try {
      const result = await this.deps.exec("claude", ["--remote", prompt], { timeout: 30_000 });
      stdout = result.stdout;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.deps.cardService.logEvent(cardId, "error", `claude --remote failed: ${msg}`);
      await this.deps.cardService.updateStatus(cardId, "failed");
      return;
    }

    const sessionIdMatch = stdout.match(SESSION_ID_RE);
    const sessionUrlMatch = stdout.match(SESSION_URL_RE);

    if (!sessionIdMatch) {
      await this.deps.cardService.logEvent(
        cardId,
        "error",
        `Could not parse session ID from claude --remote output`,
      );
      await this.deps.cardService.updateStatus(cardId, "failed");
      return;
    }

    const remoteSessionId = sessionIdMatch[1]!;
    const remoteSessionUrl = sessionUrlMatch?.[1] ?? null;

    await this.deps.db
      .insert(workflowRuns)
      .values({
        cardId,
        workflowId: "remote",
        remoteSessionId,
        remoteSessionUrl,
        startedAt: new Date(),
      })
      .returning();

    await this.deps.cardService.logEvent(
      cardId,
      "remote_session_created",
      `sessionId=${remoteSessionId}${remoteSessionUrl ? `, url=${remoteSessionUrl}` : ""}`,
    );

    this.deps.logger.info(`Card ${cardId} remote session started: ${remoteSessionId}`);
  }
}

export const remoteExecutor = new RemoteExecutor();
