import { execSync as defaultExecSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { logger as defaultLogger } from "../../utils/logger";

interface SessionInfo {
  cardId: number;
  captureInterval?: ReturnType<typeof setInterval>;
}

export interface TmuxManagerDeps {
  execSync: typeof defaultExecSync;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}

export class TmuxManager extends EventEmitter {
  private sessions: Map<string, SessionInfo> = new Map();
  private deps: TmuxManagerDeps;

  constructor(deps: Partial<TmuxManagerDeps> = {}) {
    super();
    this.deps = {
      execSync: defaultExecSync,
      logger: defaultLogger,
      ...deps,
    };
  }

  /** Check if tmux is available on the system */
  isAvailable(): boolean {
    try {
      this.deps.execSync("which tmux", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /** Create a named tmux session for a card. Returns { sessionName, created } */
  createSession(cardId: number, cwd: string): { sessionName: string; created: boolean } {
    const sessionName = `card-${cardId}`;

    if (this.sessionExists(sessionName)) {
      this.deps.logger.warn(`tmux session ${sessionName} already exists, reusing`);
      this.sessions.set(sessionName, { cardId });
      return { sessionName, created: false };
    }

    this.deps.execSync(`tmux new-session -d -s ${sessionName} -c "${cwd}"`, {
      stdio: "ignore",
    });
    this.sessions.set(sessionName, { cardId });
    this.deps.logger.info(`Created tmux session: ${sessionName} in ${cwd}`);
    return { sessionName, created: true };
  }

  /** Send a command to a tmux session */
  sendCommand(sessionName: string, command: string): void {
    const escaped = command.replace(/'/g, "'\\''");
    this.deps.execSync(`tmux send-keys -t ${sessionName} '${escaped}' Enter`);
  }

  /** Start capturing output from a tmux session via polling capture-pane */
  startCapture(sessionName: string, outputCallback: (data: string) => void): void {
    const session = this.sessions.get(sessionName);
    if (session?.captureInterval) {
      clearInterval(session.captureInterval);
    }

    const interval = setInterval(() => {
      try {
        const output = this.deps.execSync(`tmux capture-pane -t ${sessionName} -p -e -S -50`, {
          encoding: "utf-8",
          timeout: 2000,
        });
        outputCallback(output as string);
      } catch {
        clearInterval(interval);
        const s = this.sessions.get(sessionName);
        if (s) {
          s.captureInterval = undefined;
        }
      }
    }, 500);

    if (session) {
      session.captureInterval = interval;
    }
  }

  /** Stop capturing output from a tmux session */
  stopCapture(sessionName: string): void {
    const session = this.sessions.get(sessionName);
    if (session?.captureInterval) {
      clearInterval(session.captureInterval);
      session.captureInterval = undefined;
    }
  }

  /** Check if a tmux session exists */
  sessionExists(sessionName: string): boolean {
    try {
      this.deps.execSync(`tmux has-session -t ${sessionName}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /** Kill a tmux session. Returns true if session was killed, false if already dead. */
  killSession(sessionName: string): boolean {
    this.stopCapture(sessionName);
    let killed = false;
    try {
      this.deps.execSync(`tmux kill-session -t ${sessionName}`, { stdio: "ignore" });
      killed = true;
    } catch {
      /* session may already be dead */
    }
    this.sessions.delete(sessionName);
    this.deps.logger.info(`Killed tmux session: ${sessionName}`);
    return killed;
  }

  /** List all agentboard tmux sessions (card-* prefix) */
  listSessions(): string[] {
    try {
      const output = this.deps.execSync('tmux list-sessions -F "#{session_name}"', {
        encoding: "utf-8",
      });
      return (output as string)
        .trim()
        .split("\n")
        .filter((s) => s.startsWith("card-"));
    } catch {
      return [];
    }
  }
}

export const tmuxManager = new TmuxManager();

export function cardSessionName(cardId: number): string {
  return `card-${cardId}`;
}
