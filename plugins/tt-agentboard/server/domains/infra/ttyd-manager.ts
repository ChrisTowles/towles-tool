import { spawn } from "zigpty";
import type { IPty } from "zigpty";
import { logger } from "../../utils/logger";
import { ptyExecShell as defaultPtyExecShell } from "./pty-exec";
import type { PtyExecShellFn } from "./pty-exec";

interface TtydInstance {
  cardId: number;
  port: number;
  process: IPty;
}

export interface TtydManagerDeps {
  spawn: typeof spawn;
  exec: PtyExecShellFn;
  logger: typeof logger;
}

export class TtydManager {
  private instances: Map<number, TtydInstance> = new Map();
  private basePort = 7700;
  private _ttydAvailable: boolean | null = null;
  private deps: TtydManagerDeps;

  constructor(deps: Partial<TtydManagerDeps> = {}) {
    this.deps = { spawn, exec: defaultPtyExecShell, logger, ...deps };
  }

  /** Check if ttyd is available on the system (cached after first call) */
  isAvailable(): boolean {
    if (this._ttydAvailable !== null) return this._ttydAvailable;
    try {
      // Synchronous check using zigpty spawn — fire and forget, check exit code
      const pty = this.deps.spawn("which", ["ttyd"], { cols: 80, rows: 24 });
      pty.onExit(({ exitCode }) => {
        this._ttydAvailable = exitCode === 0;
      });
      // Optimistic: assume available until onExit fires
      // For the first call, we'll check asynchronously
      this._ttydAvailable = true;
      return this._ttydAvailable;
    } catch {
      this._ttydAvailable = false;
      return false;
    }
  }

  /** Get the next available port */
  private getNextPort(): number {
    const usedPorts = new Set([...this.instances.values()].map((i) => i.port));
    let port = this.basePort;
    while (usedPorts.has(port)) {
      port++;
    }
    return port;
  }

  /** Attach to a card's tmux session via ttyd */
  attach(cardId: number): { port: number; url: string } {
    const existing = this.instances.get(cardId);
    if (existing) {
      return { port: existing.port, url: `http://localhost:${existing.port}` };
    }

    const sessionName = `card-${cardId}`;
    const port = this.getNextPort();

    const proc = this.deps.spawn(
      "ttyd",
      ["--port", String(port), "--writable", "tmux", "attach", "-t", sessionName],
      {
        cols: 80,
        rows: 24,
      },
    );

    proc.onExit(({ exitCode }) => {
      this.deps.logger.info(`ttyd for card ${cardId} exited with code ${exitCode}`);
      this.instances.delete(cardId);
    });

    this.instances.set(cardId, { cardId, port, process: proc });
    this.deps.logger.info(`Started ttyd for card ${cardId} on port ${port}`);

    return { port, url: `http://localhost:${port}` };
  }

  /** Detach (kill) ttyd for a card */
  detach(cardId: number): boolean {
    const instance = this.instances.get(cardId);
    if (!instance) return false;

    try {
      instance.process.kill();
    } catch {
      // Already dead
    }
    this.instances.delete(cardId);
    this.deps.logger.info(`Stopped ttyd for card ${cardId}`);
    return true;
  }

  /** Check if a card has a ttyd instance running */
  isAttached(cardId: number): { attached: boolean; port?: number; url?: string } {
    const instance = this.instances.get(cardId);
    if (!instance) return { attached: false };
    return { attached: true, port: instance.port, url: `http://localhost:${instance.port}` };
  }

  /** Kill all ttyd instances */
  detachAll(): void {
    for (const [cardId] of this.instances) {
      this.detach(cardId);
    }
  }
}

export const ttydManager = new TtydManager();
