import { db } from "~~/server/db";
import { cards, workspaceSlots } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { agentExecutor } from "~~/server/services/agent-executor";
import { tmuxManager } from "~~/server/services/tmux-manager";
import { eventBus } from "~~/server/utils/event-bus";
import { logger } from "~~/server/utils/logger";
import { logCardEvent } from "~~/server/utils/card-events";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  const body = await readBody(event);

  // Fetch current column before update
  const current = await db.select().from(cards).where(eq(cards.id, id));
  const fromColumn = current[0]?.column ?? "backlog";

  await db
    .update(cards)
    .set({
      column: body.column,
      position: body.position,
      updatedAt: new Date(),
    })
    .where(eq(cards.id, id));

  eventBus.emit("card:moved", {
    cardId: id,
    fromColumn,
    toColumn: body.column,
  });

  await logCardEvent(id, "card_moved", `${fromColumn} → ${body.column}`);

  // If moved to in_progress, clean up stale resources first, then trigger agent
  if (body.column === "in_progress") {
    // Release any stale slots from a previous run
    const staleSlots = await db
      .select()
      .from(workspaceSlots)
      .where(eq(workspaceSlots.claimedByCardId, id));
    for (const slot of staleSlots) {
      await db
        .update(workspaceSlots)
        .set({ status: "available", claimedByCardId: null })
        .where(eq(workspaceSlots.id, slot.id));
      eventBus.emit("slot:released", { slotId: slot.id });
    }

    // Kill any stale tmux session
    const sessionName = `card-${id}`;
    tmuxManager.stopCapture(sessionName);
    tmuxManager.killSession(sessionName);

    agentExecutor.startExecution(id).catch(() => {
      eventBus.emit("card:status-changed", { cardId: id, status: "failed" });
    });
  }

  // If moved to done, archive: kill tmux session, release slot, clean up hook config
  if (body.column === "done") {
    const sessionName = `card-${id}`;
    tmuxManager.stopCapture(sessionName);
    tmuxManager.killSession(sessionName);

    // Release claimed slots
    const claimedSlots = await db
      .select()
      .from(workspaceSlots)
      .where(eq(workspaceSlots.claimedByCardId, id));

    for (const slot of claimedSlots) {
      await db
        .update(workspaceSlots)
        .set({ status: "available", claimedByCardId: null })
        .where(eq(workspaceSlots.id, slot.id));

      // Clean up Stop hook config
      const settingsPath = resolve(slot.path, ".claude", "settings.local.json");
      try {
        if (existsSync(settingsPath)) {
          unlinkSync(settingsPath);
          logger.info(`Cleaned up ${settingsPath}`);
        }
      } catch {
        // Non-fatal
      }

      eventBus.emit("slot:released", { slotId: slot.id });
    }

    await db.update(cards).set({ status: "done", updatedAt: new Date() }).where(eq(cards.id, id));

    eventBus.emit("card:status-changed", { cardId: id, status: "done" });
    logger.info(`Card ${id} archived: tmux killed, slot released`);
  }

  return { ok: true };
});
