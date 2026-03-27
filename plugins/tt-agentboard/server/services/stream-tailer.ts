import type { FSWatcher } from "node:fs";
import { watch as fsWatch, createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseStreamLine } from "../utils/stream-parser";
import { eventBus } from "../utils/event-bus";
import { logger } from "../utils/logger";

export interface StreamTailerDeps {
  eventBus: typeof eventBus;
  logger: typeof logger;
}

interface TailHandle {
  close: () => void;
}

export class StreamTailer {
  private tailers = new Map<number, TailHandle>();
  private deps: StreamTailerDeps;

  constructor(deps: Partial<StreamTailerDeps> = {}) {
    this.deps = { eventBus, logger, ...deps };
  }

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
        const fileSize = statSync(logFilePath).size;
        if (fileSize <= offset) {
          reading = false;
          return;
        }

        const stream = createReadStream(logFilePath, {
          start: offset,
          encoding: "utf-8",
        });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });

        for await (const line of rl) {
          const event = parseStreamLine(line);
          if (event) {
            this.deps.eventBus.emit("agent:activity", {
              cardId,
              event,
              timestamp: Date.now(),
            });
          }
        }

        // Use actual file size as offset — avoids CRLF byte-counting issues
        offset = fileSize;
      } catch (err) {
        if (!closed) {
          this.deps.logger.warn(`Stream tailer read error for card ${cardId}:`, err);
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
          this.deps.logger.warn(`Stream tailer watcher error for card ${cardId}:`, err);
        }
      });
    } catch (err) {
      this.deps.logger.warn(`Could not watch ${logFilePath} for card ${cardId}:`, err);
    }

    const handle: TailHandle = {
      close: () => {
        closed = true;
        watcher?.close();
      },
    };

    this.tailers.set(cardId, handle);
    this.deps.logger.info(`Started stream tailing for card ${cardId}: ${logFilePath}`);
  }

  stopTailing(cardId: number): void {
    const handle = this.tailers.get(cardId);
    if (handle) {
      handle.close();
      this.tailers.delete(cardId);
      this.deps.logger.info(`Stopped stream tailing for card ${cardId}`);
    }
  }

  stopAll(): void {
    for (const [cardId] of this.tailers) {
      this.stopTailing(cardId);
    }
  }
}

export const streamTailer = new StreamTailer();
