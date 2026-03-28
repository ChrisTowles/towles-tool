/** Shared dependency interface shapes for execution domain DI */

export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface EventBus {
  emit: (event: string, ...args: unknown[]) => boolean | void;
}

export interface StreamTailer {
  startTailing: (cardId: number, logFilePath: string) => Promise<void>;
  stopTailing: (cardId: number) => void;
}
