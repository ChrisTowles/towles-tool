import { eq } from "drizzle-orm";
import { db } from "~~/server/shared/db";
import { workspaceSlots, workflowRuns } from "~~/server/shared/db/schema";
import { getCardId } from "~~/server/utils/params";

interface DiffLine {
  type: "add" | "delete" | "context";
  content: string;
}

interface DiffChunk {
  header: string;
  lines: DiffLine[];
}

interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  chunks: DiffChunk[];
}

function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const fileBlocks = raw.split(/^diff --git /m).filter(Boolean);

  for (const block of fileBlocks) {
    const lines = block.split("\n");
    // Extract file path from "a/path b/path"
    const headerMatch = lines[0]?.match(/a\/(.+?) b\/(.+)/);
    if (!headerMatch) continue;

    const path = headerMatch[2];
    let additions = 0;
    let deletions = 0;
    const chunks: DiffChunk[] = [];
    let currentChunk: DiffChunk | null = null;

    for (const line of lines.slice(1)) {
      if (line.startsWith("@@")) {
        currentChunk = { header: line, lines: [] };
        chunks.push(currentChunk);
      } else if (currentChunk) {
        if (line.startsWith("+")) {
          additions++;
          currentChunk.lines.push({ type: "add", content: line.slice(1) });
        } else if (line.startsWith("-")) {
          deletions++;
          currentChunk.lines.push({ type: "delete", content: line.slice(1) });
        } else if (line.startsWith(" ") || line === "") {
          currentChunk.lines.push({ type: "context", content: line.slice(1) });
        }
      }
    }

    files.push({ path, additions, deletions, chunks });
  }

  return files;
}

/**
 * Get git diff for a card's workspace slot.
 * Returns uncommitted changes and branch changes.
 *
 * GET /api/agents/:cardId/diff
 */
export default defineEventHandler(async (event) => {
  const cardId = getCardId(event);

  // Try claimed slot first (active execution), then fall back to workflow run record (completed)
  let slotPath: string | null = null;
  let branch: string | null = null;

  const [claimedSlot] = await db
    .select()
    .from(workspaceSlots)
    .where(eq(workspaceSlots.claimedByCardId, cardId))
    .limit(1);

  if (claimedSlot) {
    slotPath = claimedSlot.path;
    // Still look up branch from workflow run for active cards
    const [run] = await db
      .select({ branch: workflowRuns.branch })
      .from(workflowRuns)
      .where(eq(workflowRuns.cardId, cardId))
      .limit(1);
    branch = run?.branch ?? null;
  } else {
    // Slot was released after completion — look up via workflow run
    const [run] = await db
      .select({ slotId: workflowRuns.slotId, branch: workflowRuns.branch })
      .from(workflowRuns)
      .where(eq(workflowRuns.cardId, cardId))
      .limit(1);

    if (run?.slotId) {
      const [slot] = await db
        .select()
        .from(workspaceSlots)
        .where(eq(workspaceSlots.id, run.slotId))
        .limit(1);
      slotPath = slot?.path ?? null;
      branch = run.branch;
    }
  }

  if (!slotPath) {
    return { hasDiff: false, files: [], raw: "" };
  }

  const { execSync } = await import("node:child_process");

  let raw = "";
  try {
    if (branch) {
      // Diff the card's branch against main — safe even if slot is reused by another card
      raw = execSync(`git diff origin/main...${branch}`, {
        cwd: slotPath,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      // No branch recorded — fall back to uncommitted changes (active execution)
      raw = execSync("git diff HEAD", {
        cwd: slotPath,
        encoding: "utf-8",
        timeout: 5000,
      });
    }
  } catch {
    return { hasDiff: false, files: [], raw: "" };
  }

  if (!raw.trim()) {
    return { hasDiff: false, files: [], raw: "" };
  }

  const files = parseDiff(raw);

  return { hasDiff: true, files, raw };
});
