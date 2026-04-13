import { describe, it, expect } from "bun:test";
import { contextMax, contextUsed, cacheTtlMs, extractUsageSummary } from "./claude-usage";

describe("contextMax", () => {
  it("returns 1M for sonnet with [1m] suffix", () => {
    expect(contextMax("claude-sonnet-4-5[1m]")).toBe(1_000_000);
  });

  it("returns 200K for opus", () => {
    expect(contextMax("claude-opus-4-6")).toBe(200_000);
  });

  it("returns 200K for haiku", () => {
    expect(contextMax("claude-haiku-4-5")).toBe(200_000);
  });

  it("returns 200K for empty or unknown model", () => {
    expect(contextMax("")).toBe(200_000);
    expect(contextMax("gpt-4")).toBe(200_000);
  });
});

describe("contextUsed", () => {
  it("sums input + output + cache_read + cache_creation", () => {
    expect(
      contextUsed({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
      }),
    ).toBe(1350);
  });

  it("treats missing fields as 0", () => {
    expect(contextUsed({ input_tokens: 10 })).toBe(10);
    expect(contextUsed({})).toBe(0);
  });

  it("treats null cache fields as 0", () => {
    expect(
      contextUsed({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      }),
    ).toBe(15);
  });
});

describe("cacheTtlMs", () => {
  it("returns null when no cache activity", () => {
    expect(cacheTtlMs({ input_tokens: 100, output_tokens: 50 })).toBeNull();
  });

  it("returns 1h when ephemeral_1h_input_tokens > 0", () => {
    expect(
      cacheTtlMs({
        cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 },
      }),
    ).toBe(60 * 60 * 1000);
  });

  it("returns 5m when only 5m tokens", () => {
    expect(
      cacheTtlMs({
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 100 },
      }),
    ).toBe(5 * 60 * 1000);
  });

  it("returns 5m when only cache_read (no creation this turn)", () => {
    expect(cacheTtlMs({ cache_read_input_tokens: 500 })).toBe(5 * 60 * 1000);
  });

  it("prefers 1h when both present", () => {
    expect(
      cacheTtlMs({
        cache_creation: { ephemeral_1h_input_tokens: 50, ephemeral_5m_input_tokens: 100 },
      }),
    ).toBe(60 * 60 * 1000);
  });
});

describe("extractUsageSummary", () => {
  const assistantEntry = (timestamp: string, model: string, usage: unknown) => ({
    type: "assistant",
    timestamp,
    message: { role: "assistant", model, usage },
  });

  it("returns null for empty entries", () => {
    expect(extractUsageSummary([])).toBeNull();
  });

  it("returns null when no assistant entry has usage", () => {
    expect(
      extractUsageSummary([
        {
          type: "user",
          timestamp: "2026-04-12T00:00:00Z",
          message: { role: "user", content: "hi" },
        } as never,
      ]),
    ).toBeNull();
  });

  it("extracts fields from most recent assistant entry with usage", () => {
    const entries = [
      assistantEntry("2026-04-12T00:00:00Z", "claude-opus-4-6", {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
      assistantEntry("2026-04-12T00:05:00Z", "claude-opus-4-6", {
        input_tokens: 1,
        output_tokens: 249,
        cache_read_input_tokens: 50612,
        cache_creation_input_tokens: 2297,
        cache_creation: { ephemeral_1h_input_tokens: 2297, ephemeral_5m_input_tokens: 0 },
      }),
    ] as never[];

    const result = extractUsageSummary(entries);
    expect(result).not.toBeNull();
    expect(result!.model).toBe("claude-opus-4-6");
    expect(result!.contextUsed).toBe(53159);
    expect(result!.contextMax).toBe(200_000);
    expect(result!.cacheTtlMs).toBe(60 * 60 * 1000);
    expect(result!.lastActivityAt).toBe(new Date("2026-04-12T00:05:00Z").getTime());
    expect(result!.cacheExpiresAt).toBe(result!.lastActivityAt + 60 * 60 * 1000);
  });

  it("leaves cacheExpiresAt and cacheTtlMs null when no cache activity", () => {
    const entries = [
      assistantEntry("2026-04-12T00:00:00Z", "claude-opus-4-6", {
        input_tokens: 100,
        output_tokens: 50,
      }),
    ] as never[];

    const result = extractUsageSummary(entries);
    expect(result!.cacheExpiresAt).toBeNull();
    expect(result!.cacheTtlMs).toBeNull();
  });
});
