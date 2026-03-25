import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { logger } from "../utils/logger";

interface SessionInfo {
  cardId: number;
  captureInterval?: ReturnType<typeof setInterval>;
}

export class TmuxManager extends EventEmitter {
  private sessions: Map<string, SessionInfo> = new Map();

  /** Check if tmux is available on the system */
  isAvailable(): boolean {
    try {
      execSync("which tmux", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /** Create a named tmux session for a card */
  createSession(cardId: number, cwd: string): string {
    const sessionName = `card-${cardId}`;

    if (this.sessionExists(sessionName)) {
      logger.warn(`tmux session ${sessionName} already exists, reusing`);
      this.sessions.set(sessionName, { cardId });
      return sessionName;
    }

    execSync(`tmux new-session -d -s ${sessionName} -c "${cwd}"`, {
      stdio: "ignore",
    });
    this.sessions.set(sessionName, { cardId });
    logger.info(`Created tmux session: ${sessionName} in ${cwd}`);
    return sessionName;
  }

  /** Send a command to a tmux session */
  sendCommand(sessionName: string, command: string): void {
    const escaped = command.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t ${sessionName} '${escaped}' Enter`);
  }

  /** Start capturing output from a tmux session via polling capture-pane */
  startCapture(sessionName: string, outputCallback: (data: string) => void): void {
    const session = this.sessions.get(sessionName);
    if (session?.captureInterval) {
      clearInterval(session.captureInterval);
    }

    const interval = setInterval(() => {
      try {
        const output = execSync(`tmux capture-pane -t ${sessionName} -p -e -S -50`, {
          encoding: "utf-8",
          timeout: 2000,
        });
        outputCallback(output);
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
      execSync(`tmux has-session -t ${sessionName}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /** Kill a tmux session */
  killSession(sessionName: string): void {
    this.stopCapture(sessionName);
    try {
      execSync(`tmux kill-session -t ${sessionName}`, { stdio: "ignore" });
    } catch {
      /* session may already be dead */
    }
    this.sessions.delete(sessionName);
    logger.info(`Killed tmux session: ${sessionName}`);
  }

  /** List all agentboard tmux sessions (card-* prefix) */
  listSessions(): string[] {
    try {
      const output = execSync('tmux list-sessions -F "#{session_name}"', {
        encoding: "utf-8",
      });
      return output
        .trim()
        .split("\n")
        .filter((s) => s.startsWith("card-"));
    } catch {
      return [];
    }
  }
}

export const tmuxManager = new TmuxManager();
