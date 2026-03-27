import { EventEmitter } from "node:events";
import type { Column, CardStatus } from "../domains/cards/types";

export type { Column, CardStatus };

export interface AgentActivityEvent {
  kind: "tool_use" | "thinking" | "text" | "result";
  [key: string]: unknown;
}

export interface EventMap {
  "card:created": { cardId: number };
  "card:moved": { cardId: number; fromColumn: Column; toColumn: Column };
  "card:status-changed": { cardId: number; status: CardStatus };
  "card:deleted": { cardId: number };
  "slot:claimed": { slotId: number; cardId: number };
  "slot:released": { slotId: number };
  "step:started": { cardId: number; stepId: string };
  "step:completed": { cardId: number; stepId: string; passed: boolean };
  "step:failed": { cardId: number; stepId: string; retryNumber: number };
  "workflow:completed": { cardId: number; status: "success" | "failed" };
  "agent:output": { cardId: number; content: string };
  "agent:activity": {
    cardId: number;
    event: AgentActivityEvent;
    timestamp: number;
  };
  "agent:waiting": { cardId: number; question: string };
  "github:issue-found": { issueNumber: number; repoId: number };
}

export class TypedEventBus {
  private ee = new EventEmitter();

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    this.ee.emit(event, data);
  }

  on<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void {
    this.ee.on(event, handler as (...args: unknown[]) => void);
  }

  off<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void {
    this.ee.off(event, handler as (...args: unknown[]) => void);
  }

  once<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void {
    this.ee.once(event, handler as (...args: unknown[]) => void);
  }
}

export const eventBus = new TypedEventBus();
