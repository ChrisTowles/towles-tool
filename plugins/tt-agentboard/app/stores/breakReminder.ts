import { defineStore } from "pinia";
import { ref, computed } from "vue";

export const BREAK_TYPES = ["stairs", "walk", "stretch", "water"] as const;
export type BreakType = (typeof BREAK_TYPES)[number];

export interface BreakConfig {
  intervalMinutes: number;
  enabledBreakTypes: BreakType[];
  snoozeDurationMinutes: number;
  idleThresholdMinutes: number;
  escalationThresholdMinutes: number;
  soundEnabled: boolean;
}

export interface DailyStats {
  date: string; // YYYY-MM-DD
  completed: number;
  skipped: number;
  snoozed: number;
}

const BREAK_PROMPTS: Record<BreakType, string> = {
  stairs: "Hit the stairs — 2 flights up and back",
  walk: "Take a lap around the floor",
  stretch: "Stand up and stretch for 2 minutes",
  water: "Refill your water bottle",
};

// Weights for rotation: stairs and walks weighted higher
const BREAK_WEIGHTS: Record<BreakType, number> = {
  stairs: 3,
  walk: 3,
  stretch: 2,
  water: 2,
};

const STORAGE_KEY = "agentboard-break-reminders";
const STATS_KEY = "agentboard-break-stats";
const CONFIG_KEY = "agentboard-break-config";

const DEFAULT_CONFIG: BreakConfig = {
  intervalMinutes: 55,
  enabledBreakTypes: [...BREAK_TYPES],
  snoozeDurationMinutes: 15,
  idleThresholdMinutes: 3,
  escalationThresholdMinutes: 90,
  soundEnabled: true,
};

function todayDateString(): string {
  return new Date().toLocaleDateString("en-CA");
}

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    // ignore parse errors
  }
  return fallback;
}

function buildWeightedQueue(enabledTypes: BreakType[]): BreakType[] {
  const pool: BreakType[] = [];
  for (const t of enabledTypes) {
    const weight = BREAK_WEIGHTS[t] ?? 1;
    for (let i = 0; i < weight; i++) {
      pool.push(t);
    }
  }
  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

export const useBreakReminderStore = defineStore("breakReminder", () => {
  // --- Config ---
  const config = ref<BreakConfig>({ ...DEFAULT_CONFIG });

  // --- State ---
  const lastBreakTimestamp = ref<number | null>(null);
  const lastInputTimestamp = ref<number>(Date.now());
  const currentSnoozeExpiry = ref<number | null>(null);
  const todayStats = ref<DailyStats>({ date: todayDateString(), completed: 0, skipped: 0, snoozed: 0 });
  const breakQueue = ref<BreakType[]>([]);
  const focusModeUntil = ref<number | null>(null);
  const isPaused = ref(false);
  const lastBreakType = ref<BreakType | null>(null);

  // --- UI State ---
  const showToast = ref(false);
  const showBanner = ref(false);
  const currentPrompt = ref("");
  const currentBreakType = ref<BreakType | null>(null);
  const hasSnoozedCurrent = ref(false);

  // --- Timer ---
  let tickInterval: ReturnType<typeof setInterval> | null = null;

  // --- Persistence ---
  function saveState() {
    const data = {
      lastBreakTimestamp: lastBreakTimestamp.value,
      currentSnoozeExpiry: currentSnoozeExpiry.value,
      focusModeUntil: focusModeUntil.value,
      isPaused: isPaused.value,
      lastBreakType: lastBreakType.value,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    localStorage.setItem(STATS_KEY, JSON.stringify(todayStats.value));
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config.value));
  }

  function loadState() {
    config.value = loadFromStorage(CONFIG_KEY, { ...DEFAULT_CONFIG });

    const saved = loadFromStorage<{
      lastBreakTimestamp: number | null;
      currentSnoozeExpiry: number | null;
      focusModeUntil: number | null;
      isPaused: boolean;
      lastBreakType: BreakType | null;
    }>(STORAGE_KEY, {
      lastBreakTimestamp: null,
      currentSnoozeExpiry: null,
      focusModeUntil: null,
      isPaused: false,
      lastBreakType: null,
    });

    lastBreakTimestamp.value = saved.lastBreakTimestamp;
    currentSnoozeExpiry.value = saved.currentSnoozeExpiry;
    focusModeUntil.value = saved.focusModeUntil;
    isPaused.value = saved.isPaused;
    lastBreakType.value = saved.lastBreakType;

    const savedStats = loadFromStorage<DailyStats>(STATS_KEY, {
      date: todayDateString(),
      completed: 0,
      skipped: 0,
      snoozed: 0,
    });

    // Reset stats if it's a new day
    if (savedStats.date === todayDateString()) {
      todayStats.value = savedStats;
    } else {
      todayStats.value = { date: todayDateString(), completed: 0, skipped: 0, snoozed: 0 };
    }

    breakQueue.value = buildWeightedQueue(config.value.enabledBreakTypes);
  }

  // --- Break Queue ---
  function nextBreakType(): BreakType {
    if (breakQueue.value.length === 0) {
      breakQueue.value = buildWeightedQueue(config.value.enabledBreakTypes);
    }

    // Avoid repeating the same type back-to-back
    for (let i = 0; i < breakQueue.value.length; i++) {
      if (breakQueue.value[i] !== lastBreakType.value || breakQueue.value.length === 1) {
        return breakQueue.value.splice(i, 1)[0];
      }
    }
    return breakQueue.value.shift()!;
  }

  // --- Computed ---
  const minutesSinceLastBreak = computed(() => {
    if (!lastBreakTimestamp.value) return Infinity;
    return (Date.now() - lastBreakTimestamp.value) / 60_000;
  });

  const minutesSinceLastInput = computed(() => {
    return (Date.now() - lastInputTimestamp.value) / 60_000;
  });

  const isInFocusMode = computed(() => {
    if (!focusModeUntil.value) return false;
    return Date.now() < focusModeUntil.value;
  });

  const nextBreakIn = computed(() => {
    if (isPaused.value || isInFocusMode.value) return null;
    const elapsed = minutesSinceLastBreak.value;
    const remaining = config.value.intervalMinutes - elapsed;
    return Math.max(0, Math.round(remaining));
  });

  const expectedBreaksToday = computed(() => {
    // Rough estimate: 8 hours / interval
    return Math.floor(480 / config.value.intervalMinutes);
  });

  // --- Actions ---
  function recordInput() {
    lastInputTimestamp.value = Date.now();
  }

  function showBreakPrompt(escalated: boolean) {
    if (showToast.value || showBanner.value) return; // Don't stack

    const breakType = nextBreakType();
    currentBreakType.value = breakType;
    currentPrompt.value = BREAK_PROMPTS[breakType];
    hasSnoozedCurrent.value = false;

    if (escalated) {
      showBanner.value = true;
      showToast.value = false;
    } else {
      showToast.value = true;
      showBanner.value = false;
    }

    if (config.value.soundEnabled && escalated) {
      playNotificationSound();
    }

    // Auto-dismiss toast after 30 seconds if no interaction
    if (!escalated) {
      setTimeout(() => {
        if (showToast.value && !hasSnoozedCurrent.value) {
          skipBreak();
        }
      }, 30_000);
    }
  }

  function completeBreak() {
    lastBreakTimestamp.value = Date.now();
    lastBreakType.value = currentBreakType.value;
    currentSnoozeExpiry.value = null;
    todayStats.value.completed++;
    showToast.value = false;
    showBanner.value = false;
    saveState();
  }

  function snoozeBreak() {
    if (hasSnoozedCurrent.value) {
      // Already snoozed once — skip instead
      skipBreak();
      return;
    }
    hasSnoozedCurrent.value = true;
    currentSnoozeExpiry.value = Date.now() + config.value.snoozeDurationMinutes * 60_000;
    todayStats.value.snoozed++;
    showToast.value = false;
    showBanner.value = false;
    saveState();
  }

  function skipBreak() {
    lastBreakTimestamp.value = Date.now();
    lastBreakType.value = currentBreakType.value;
    currentSnoozeExpiry.value = null;
    todayStats.value.skipped++;
    showToast.value = false;
    showBanner.value = false;
    saveState();
  }

  function enableFocusMode(durationMinutes: number) {
    focusModeUntil.value = Date.now() + durationMinutes * 60_000;
    showToast.value = false;
    showBanner.value = false;
    saveState();
  }

  function disableFocusMode() {
    focusModeUntil.value = null;
    saveState();
  }

  function togglePause() {
    isPaused.value = !isPaused.value;
    if (isPaused.value) {
      showToast.value = false;
      showBanner.value = false;
    }
    saveState();
  }

  function updateConfig(updates: Partial<BreakConfig>) {
    Object.assign(config.value, updates);
    if (updates.enabledBreakTypes) {
      breakQueue.value = buildWeightedQueue(updates.enabledBreakTypes);
    }
    saveState();
  }

  // --- Timer Tick (every 30 seconds) ---
  function tick() {
    // Check for day rollover
    if (todayStats.value.date !== todayDateString()) {
      todayStats.value = { date: todayDateString(), completed: 0, skipped: 0, snoozed: 0 };
      saveState();
    }

    // Clear expired focus mode
    if (focusModeUntil.value && Date.now() >= focusModeUntil.value) {
      focusModeUntil.value = null;
      saveState();
    }

    if (isPaused.value || isInFocusMode.value) return;

    // If snooze is active and not expired, skip
    if (currentSnoozeExpiry.value && Date.now() < currentSnoozeExpiry.value) return;

    // If snooze expired, the snoozed prompt is now due again
    if (currentSnoozeExpiry.value && Date.now() >= currentSnoozeExpiry.value) {
      currentSnoozeExpiry.value = null;
      // Show as snoozed-and-returned — if ignored again, will be skipped by auto-dismiss
      showBreakPrompt(false);
      // Mark that this was already snoozed so next dismissal skips
      hasSnoozedCurrent.value = true;
      saveState();
      return;
    }

    const intervalMs = config.value.intervalMinutes * 60_000;
    const timeSinceBreak = lastBreakTimestamp.value ? Date.now() - lastBreakTimestamp.value : Infinity;

    // Not enough time has passed
    if (timeSinceBreak < intervalMs) return;

    // Idle detection: user away for 3+ minutes — assume they took a break
    const idleMs = config.value.idleThresholdMinutes * 60_000;
    if (Date.now() - lastInputTimestamp.value > idleMs) {
      lastBreakTimestamp.value = Date.now();
      todayStats.value.completed++;
      saveState();
      return;
    }

    // Escalation: 90+ minutes continuous work
    const escalationMs = config.value.escalationThresholdMinutes * 60_000;
    const isEscalated = timeSinceBreak >= escalationMs;

    showBreakPrompt(isEscalated);
  }

  function playNotificationSound() {
    try {
      const ctx = new AudioContext();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.frequency.value = 440;
      oscillator.type = "sine";
      gain.gain.value = 0.15;
      oscillator.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      oscillator.stop(ctx.currentTime + 0.5);
    } catch {
      // Audio not available
    }
  }

  // --- Lifecycle ---
  function start() {
    loadState();

    // If no break has been recorded yet, start the timer from now
    if (!lastBreakTimestamp.value) {
      lastBreakTimestamp.value = Date.now();
      saveState();
    }

    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(tick, 30_000);
  }

  function stop() {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
  }

  return {
    // Config
    config,
    // State
    lastBreakTimestamp,
    lastInputTimestamp,
    currentSnoozeExpiry,
    todayStats,
    focusModeUntil,
    isPaused,
    // UI State
    showToast,
    showBanner,
    currentPrompt,
    currentBreakType,
    hasSnoozedCurrent,
    // Computed
    minutesSinceLastBreak,
    minutesSinceLastInput,
    isInFocusMode,
    nextBreakIn,
    expectedBreaksToday,
    // Actions
    recordInput,
    completeBreak,
    snoozeBreak,
    skipBreak,
    enableFocusMode,
    disableFocusMode,
    togglePause,
    updateConfig,
    start,
    stop,
    tick,
  };
});
