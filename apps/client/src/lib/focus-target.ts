import { useRef } from "react";
import { useAtomEffect } from "./atoms/react";
import * as Atom from "effect/reactivity/Atom";
import { appRegistry } from "./atoms/registry";
import type { ScreenId } from "./screens";

/** Deep-link focus: `openTab(screen)` lands on a screen but never on a row, so a
 * {@link FocusTarget} carries "reveal *this* row once you're there" — a one-shot,
 * not a persistent selection. A DOM-free singleton to dodge an import cycle
 * between `workspace.tsx` and the destination screens. */

type FocusKind = "pr" | "todo" | "repo" | "issue";

export type FocusTarget = { screen: ScreenId; kind: FocusKind; id: string };

/** The pending deep link, or null. Written by `openTabWithFocus`; taken once
 * by the destination screen with {@link consumeFocusTarget}. */
export const focusTargetAtom = Atom.make<FocusTarget | null>(null).pipe(Atom.keepAlive);

/** Pure: the target `screen` takes, and what is left pending after it. A
 * request for another screen is left in place for its real destination. */
export function takeTarget(
  pending: FocusTarget | null,
  screen: ScreenId,
): [taken: FocusTarget | null, left: FocusTarget | null] {
  return pending !== null && pending.screen === screen ? [pending, null] : [null, pending];
}

const consumeFocusTarget = (screen: ScreenId): FocusTarget | null =>
  appRegistry.modify(focusTargetAtom, (p) => takeTarget(p, screen));

/** Literals, so Tailwind's scanner keeps them in the build. */
const FLASH_CLASSES = ["ring-2", "ring-inset", "ring-warn"];
const FLASH_MS = 1600;
/** The row may not be painted yet (snapshot still loading) — retry a few frames. */
const MAX_ATTEMPTS = 12;
const RETRY_MS = 150;

/** Matched on the dataset: ids hold `/` and `#`, so a selector would be fragile. */
function findFocusRow(container: HTMLElement, kind: FocusKind, id: string): HTMLElement | null {
  const rows = container.querySelectorAll<HTMLElement>(`[data-focus-kind="${kind}"]`);
  for (const row of rows) {
    if (row.dataset.focusId === id) return row;
  }
  return null;
}

function flashRow(el: HTMLElement): void {
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add(...FLASH_CLASSES);
  window.setTimeout(() => el.classList.remove(...FLASH_CLASSES), FLASH_MS);
}

/** Attach the returned ref to the scroll container holding the
 * `data-focus-kind`/`data-focus-id` rows. Scoping the lookup to it keeps a
 * still-mounted background screen's identical row from matching. */
export function useFocusTarget<T extends HTMLElement>(screen: ScreenId) {
  const containerRef = useRef<T>(null);
  useAtomEffect(focusTargetAtom, (pending) => {
    if (pending?.screen !== screen) return;
    const target = consumeFocusTarget(screen);
    if (!target) return;
    let attempts = 0;
    const attempt = () => {
      const container = containerRef.current;
      const el = container ? findFocusRow(container, target.kind, target.id) : null;
      if (el) return flashRow(el);
      if (++attempts < MAX_ATTEMPTS) window.setTimeout(attempt, RETRY_MS);
    };
    attempt();
  });
  return containerRef;
}
