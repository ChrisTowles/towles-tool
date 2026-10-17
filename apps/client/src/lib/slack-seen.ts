/** The newest Slack message the user has actually looked at, shared by the
 * Messages screen and the watched-DM drawer so seeing it in one clears it in
 * the other. Slack ids are `"seconds.micros"` strings whose seconds part
 * changes width over time, so they order numerically, never lexically. */

const SEEN_KEY = "tt-slack-seen";

type Stamped = { tsRaw: string; fromMe: boolean };

/** Negative, zero or positive like a sort comparator. Unparseable ids sort
 * before everything, so a malformed stored value can only over-report news. */
function compareTs(a: string, b: string): number {
  const [aSec, aMicro] = splitTs(a);
  const [bSec, bMicro] = splitTs(b);
  return aSec - bSec || aMicro - bMicro;
}

function splitTs(ts: string): [number, number] {
  const [sec = "", frac = ""] = ts.split(".");
  const seconds = Number(sec);
  const micros = Number(frac.padEnd(6, "0").slice(0, 6));
  return [Number.isFinite(seconds) ? seconds : -1, Number.isFinite(micros) ? micros : 0];
}

/** The first top-level message from the other side that landed after
 * `lastSeen`; `null` when nothing is new, or on a first visit (`lastSeen`
 * null), where "everything" is news to no one. Your own messages never count. */
export function firstUnseenIndex(
  messages: readonly Stamped[],
  lastSeen: string | null,
): number | null {
  if (lastSeen === null) return null;
  const at = messages.findIndex((m) => !m.fromMe && compareTs(m.tsRaw, lastSeen) > 0);
  return at === -1 ? null : at;
}

/** The newest id in the list, own messages included: sending means you saw
 * everything before it. `null` for an empty list. */
export function newestTs(messages: readonly Stamped[]): string | null {
  let newest: string | null = null;
  for (const m of messages) {
    if (m.tsRaw && (newest === null || compareTs(m.tsRaw, newest) > 0)) newest = m.tsRaw;
  }
  return newest;
}

/** Seen only moves forward: an older, stale list must not resurrect a divider. */
function advanceSeen(current: string | null, next: string | null): string | null {
  if (next === null) return current;
  return current === null || compareTs(next, current) > 0 ? next : current;
}

function parseSeen(raw: string | null): string | null {
  return raw !== null && /^\d+(\.\d+)?$/.test(raw) ? raw : null;
}

let lastSeen: string | null | undefined;

export function getLastSeen(): string | null {
  if (lastSeen === undefined) {
    try {
      lastSeen = parseSeen(localStorage.getItem(SEEN_KEY));
    } catch {
      lastSeen = null;
    }
  }
  return lastSeen;
}

export function markSeen(ts: string | null): void {
  const next = advanceSeen(getLastSeen(), ts);
  if (next === lastSeen) return;
  lastSeen = next;
  try {
    if (next !== null) localStorage.setItem(SEEN_KEY, next);
  } catch {
    // A divider shown once more beats a render that throws.
  }
}
