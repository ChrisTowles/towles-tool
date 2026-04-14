/**
 * Shared error base class for towles-tool.
 *
 * Uses the native ES2022 `Error.cause` option so stack traces chain properly.
 */
export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}
