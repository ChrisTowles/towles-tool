import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useBreakReminderStore } from "../../app/stores/breakReminder";

// Minimal localStorage stub
const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
};
Object.defineProperty(globalThis, "localStorage", { value: localStorageStub, writable: true });

// Stub AudioContext for sound tests
class FakeOscillator {
  frequency = { value: 0 };
  type = "sine";
  connect() {}
  start() {}
  stop() {}
}
class FakeGain {
  gain = { value: 0, exponentialRampToValueAtTime() {} };
  connect() {}
}
Object.defineProperty(globalThis, "AudioContext", {
  value: class {
    currentTime = 0;
    createOscillator() {
      return new FakeOscillator();
    }
    createGain() {
      return new FakeGain();
    }
    destination = {};
  },
  writable: true,
});

describe("breakReminder store", () => {
  beforeEach(() => {
    storage.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    const store = useBreakReminderStore();
    store.stop();
  });

  it("initializes with default config", () => {
    const store = useBreakReminderStore();
    store.start();
    expect(store.config.intervalMinutes).toBe(55);
    expect(store.config.enabledBreakTypes).toEqual(["stairs", "walk", "stretch", "water"]);
    expect(store.todayStats.completed).toBe(0);
    expect(store.todayStats.skipped).toBe(0);
  });

  it("completeBreak increments completed count", () => {
    const store = useBreakReminderStore();
    store.start();
    // Force a prompt to be showing
    store.showToast = true;
    store.currentBreakType = "stairs";
    store.completeBreak();
    expect(store.todayStats.completed).toBe(1);
    expect(store.showToast).toBe(false);
  });

  it("snoozeBreak sets snooze expiry and increments snoozed count", () => {
    const store = useBreakReminderStore();
    store.start();
    store.showToast = true;
    store.currentBreakType = "walk";
    store.snoozeBreak();
    expect(store.todayStats.snoozed).toBe(1);
    expect(store.currentSnoozeExpiry).not.toBeNull();
    expect(store.showToast).toBe(false);
  });

  it("second snooze triggers skip instead", () => {
    const store = useBreakReminderStore();
    store.start();
    store.showToast = true;
    store.currentBreakType = "walk";
    store.snoozeBreak(); // first snooze
    store.showToast = true;
    store.snoozeBreak(); // second snooze should skip
    expect(store.todayStats.skipped).toBe(1);
    expect(store.todayStats.snoozed).toBe(1);
    expect(store.currentSnoozeExpiry).toBeNull();
  });

  it("skipBreak increments skipped count", () => {
    const store = useBreakReminderStore();
    store.start();
    store.showToast = true;
    store.currentBreakType = "stretch";
    store.skipBreak();
    expect(store.todayStats.skipped).toBe(1);
    expect(store.showToast).toBe(false);
  });

  it("enableFocusMode sets focusModeUntil", () => {
    const store = useBreakReminderStore();
    store.start();
    store.enableFocusMode(30);
    expect(store.focusModeUntil).not.toBeNull();
    expect(store.isInFocusMode).toBe(true);
  });

  it("disableFocusMode clears focusModeUntil", () => {
    const store = useBreakReminderStore();
    store.start();
    store.enableFocusMode(30);
    store.disableFocusMode();
    expect(store.focusModeUntil).toBeNull();
    expect(store.isInFocusMode).toBe(false);
  });

  it("togglePause toggles isPaused", () => {
    const store = useBreakReminderStore();
    store.start();
    expect(store.isPaused).toBe(false);
    store.togglePause();
    expect(store.isPaused).toBe(true);
    store.togglePause();
    expect(store.isPaused).toBe(false);
  });

  it("updateConfig persists changes", () => {
    const store = useBreakReminderStore();
    store.start();
    store.updateConfig({ intervalMinutes: 30, soundEnabled: false });
    expect(store.config.intervalMinutes).toBe(30);
    expect(store.config.soundEnabled).toBe(false);

    // Verify persistence
    const raw = storage.get("agentboard-break-config");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.intervalMinutes).toBe(30);
  });

  it("tick skips when paused", () => {
    const store = useBreakReminderStore();
    store.start();
    store.isPaused = true;
    // Force last break far in the past
    store.lastBreakTimestamp = Date.now() - 120 * 60_000;
    store.tick();
    expect(store.showToast).toBe(false);
    expect(store.showBanner).toBe(false);
  });

  it("tick skips when in focus mode", () => {
    const store = useBreakReminderStore();
    store.start();
    store.enableFocusMode(60);
    store.lastBreakTimestamp = Date.now() - 120 * 60_000;
    store.tick();
    expect(store.showToast).toBe(false);
    expect(store.showBanner).toBe(false);
  });

  it("tick auto-completes break when user is idle", () => {
    const store = useBreakReminderStore();
    store.start();
    // Last break was 60 minutes ago (past interval)
    store.lastBreakTimestamp = Date.now() - 60 * 60_000;
    // User has been idle for 5 minutes (past idle threshold)
    store.lastInputTimestamp = Date.now() - 5 * 60_000;
    store.tick();
    expect(store.todayStats.completed).toBe(1);
    expect(store.showToast).toBe(false);
  });

  it("tick shows standard toast when interval elapsed", () => {
    const store = useBreakReminderStore();
    store.start();
    store.lastBreakTimestamp = Date.now() - 60 * 60_000;
    store.lastInputTimestamp = Date.now(); // actively working
    store.tick();
    expect(store.showToast).toBe(true);
    expect(store.showBanner).toBe(false);
    expect(store.currentPrompt).toBeTruthy();
  });

  it("tick shows escalated banner after 90+ minutes", () => {
    const store = useBreakReminderStore();
    store.start();
    store.lastBreakTimestamp = Date.now() - 95 * 60_000;
    store.lastInputTimestamp = Date.now();
    store.tick();
    expect(store.showBanner).toBe(true);
    expect(store.showToast).toBe(false);
  });

  it("recordInput updates lastInputTimestamp", () => {
    const store = useBreakReminderStore();
    store.start();
    const before = store.lastInputTimestamp;
    store.recordInput();
    expect(store.lastInputTimestamp).toBeGreaterThanOrEqual(before);
  });

  it("persists and restores state across instances", () => {
    const store1 = useBreakReminderStore();
    store1.start();
    store1.showToast = true;
    store1.currentBreakType = "water";
    store1.completeBreak();
    store1.stop();

    // New pinia instance to simulate page reload
    setActivePinia(createPinia());
    const store2 = useBreakReminderStore();
    store2.start();
    expect(store2.todayStats.completed).toBe(1);
    expect(store2.lastBreakTimestamp).not.toBeNull();
  });
});
