import type { FSWatcher } from "node:fs";
import { watch as fsWatch, createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseStreamLine } from "../utils/stream-parser";
import { eventBus } from "../utils/event-bus";
import { logger } from "../utils/logger";

interface TailHandle {
  close: () => void;
}

class StreamTailer {
  private tailers = new Map<number, TailHandle>();

  async startTailing(cardId: number, logFilePath: string): Promise<void> {
    this.stopTailing(cardId);

    let offset = 0;
    let watcher: FSWatcher | null = null;
    let closed = false;
    let reading = false;

    const readNewLines = async () => {
      if (closed || reading) return;
      reading = true;

      try {
        const fh = await open(logFilePath, "r");
        const stat = await fh.stat();

        if (stat.size <= offset) {
          await fh.close();
          reading = false;
          return;
        }

        const stream = createReadStream(logFilePath, {
          start: offset,
          encoding: "utf-8",
        });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });

        let newOffset = offset;

        for await (const line of rl) {
          // +1 for the newline character
          newOffset += Buffer.byteLength(line, "utf-8") + 1;

          const event = parseStreamLine(line);
          if (event) {
            eventBus.emit("agent:activity", {
              cardId,
              event,
              timestamp: Date.now(),
            });
          }
        }

        offset = newOffset;
        await fh.close();
      } catch (err) {
        if (!closed) {
          logger.warn(`Stream tailer read error for card ${cardId}:`, err);
        }
      }

      reading = false;
    };

    // Initial read from start of file
    await readNewLines();

    // Watch for file changes
    try {
      watcher = fsWatch(logFilePath, () => {
        readNewLines();
      });

      watcher.on("error", (err) => {
        if (!closed) {
          logger.warn(`Stream tailer watcher error for card ${cardId}:`, err);
        }
      });
    } catch (err) {
      logger.warn(`Could not watch ${logFilePath} for card ${cardId}:`, err);
    }

    const handle: TailHandle = {
      close: () => {
        closed = true;
        watcher?.close();
      },
    };

    this.tailers.set(cardId, handle);
    logger.info(`Started stream tailing for card ${cardId}: ${logFilePath}`);
  }

  stopTailing(cardId: number): void {
    const handle = this.tailers.get(cardId);
    if (handle) {
      handle.close();
      this.tailers.delete(cardId);
      logger.info(`Stopped stream tailing for card ${cardId}`);
    }
  }

  stopAll(): void {
    for (const [cardId] of this.tailers) {
      this.stopTailing(cardId);
    }
  }
}

export const streamTailer = new StreamTailer();
