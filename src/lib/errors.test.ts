import { describe, expect, it } from "vitest";
import { AppError } from "./errors";

describe("AppError", () => {
  it("carries code and message", () => {
    const err = new AppError("my_code", "boom");
    expect(err.code).toBe("my_code");
    expect(err.message).toBe("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });

  it("uses the constructor name as the error name", () => {
    class ChildError extends AppError {
      constructor(message: string) {
        super("child_code", message);
      }
    }
    expect(new AppError("c", "m").name).toBe("AppError");
    expect(new ChildError("m").name).toBe("ChildError");
  });

  it("forwards cause to the native Error.cause", () => {
    const root = new Error("root");
    const err = new AppError("wrapped", "outer", { cause: root });
    expect(err.cause).toBe(root);
  });

  it("leaves cause undefined when not provided", () => {
    const err = new AppError("nope", "no cause");
    expect(err.cause).toBeUndefined();
  });
});
