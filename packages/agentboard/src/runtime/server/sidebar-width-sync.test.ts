import { describe, expect, it } from "vitest";
import type { SidebarPane } from "../contracts/mux";
import {
  WINDOW_RESIZE_COOLDOWN_MS,
  resolveSidebarWidthFromResizeContext,
  snapshotSidebarWindows,
} from "./sidebar-width-sync";
import type {
  SidebarResizeContext,
  SidebarResizeSuppression,
  SidebarWindowSnapshot,
} from "./sidebar-width-sync";

const PANE_ID = "%1";
const WINDOW_ID = "@1";

function makePane(width: number, windowWidth: number): SidebarPane {
  return { paneId: PANE_ID, sessionName: "main", windowId: WINDOW_ID, width, windowWidth };
}

function resolve(params: {
  ctx: SidebarResizeContext;
  panes: SidebarPane[];
  previous: Map<string, SidebarWindowSnapshot>;
  suppressed?: Map<string, SidebarResizeSuppression>;
  cooldown?: Map<string, number>;
  now: number;
}) {
  return resolveSidebarWidthFromResizeContext({
    ctx: params.ctx,
    panes: params.panes,
    previousByWindow: params.previous,
    suppressedByPane: params.suppressed ?? new Map(),
    windowResizeCooldown: params.cooldown ?? new Map(),
    now: params.now,
  });
}

describe("resolveSidebarWidthFromResizeContext", () => {
  it("adopts a deliberate divider drag (window width unchanged, no recent resize)", () => {
    const previous = snapshotSidebarWindows([makePane(40, 200)]);
    const result = resolve({
      ctx: { paneId: PANE_ID, windowId: WINDOW_ID, width: 50, windowWidth: 200 },
      panes: [makePane(50, 200)],
      previous,
      now: 1_000,
    });
    expect(result).toBe(50);
  });

  it("does not adopt a proportional rescale when the terminal window changed size", () => {
    const previous = snapshotSidebarWindows([makePane(40, 200)]);
    const cooldown = new Map<string, number>();
    const result = resolve({
      ctx: { paneId: PANE_ID, windowId: WINDOW_ID, width: 20, windowWidth: 100 },
      panes: [makePane(20, 100)],
      previous,
      cooldown,
      now: 1_000,
    });
    expect(result).toBeNull();
    // A cooldown is opened so the proportional echo events that follow are ignored.
    expect(cooldown.get(WINDOW_ID)).toBe(1_000 + WINDOW_RESIZE_COOLDOWN_MS);
  });

  it("does not adopt the shrunken proportional echo that arrives after the window settles", () => {
    // Regression: resizing the terminal used to ratchet the sidebar smaller.
    // 1) Window shrinks 200 -> 100; sidebar rescaled 40 -> 20. Opens cooldown.
    const previous = new Map<string, SidebarWindowSnapshot>();
    previous.set(WINDOW_ID, { width: 40, windowWidth: 200 });
    const cooldown = new Map<string, number>();
    const suppressed = new Map<string, SidebarResizeSuppression>();

    resolve({
      ctx: { paneId: PANE_ID, windowId: WINDOW_ID, width: 20, windowWidth: 100 },
      panes: [makePane(20, 100)],
      previous,
      suppressed,
      cooldown,
      now: 1_000,
    });
    // Snapshot now reflects the settled window width with the pre-enforcement width.
    previous.set(WINDOW_ID, { width: 20, windowWidth: 100 });

    // 2) A stray proportional echo fires at the settled window width (100) with
    //    the small width (20). Previously this matched the "divider drag"
    //    heuristic and got adopted, shrinking the sidebar permanently.
    const echo = resolve({
      ctx: { paneId: PANE_ID, windowId: WINDOW_ID, width: 18, windowWidth: 100 },
      panes: [makePane(18, 100)],
      previous,
      suppressed,
      cooldown,
      now: 1_100,
    });
    expect(echo).toBeNull();
  });

  it("adopts a divider drag again once the cooldown elapses", () => {
    const previous = new Map<string, SidebarWindowSnapshot>();
    previous.set(WINDOW_ID, { width: 40, windowWidth: 100 });
    const cooldown = new Map<string, number>();
    cooldown.set(WINDOW_ID, 1_000 + WINDOW_RESIZE_COOLDOWN_MS);

    const result = resolve({
      ctx: { paneId: PANE_ID, windowId: WINDOW_ID, width: 55, windowWidth: 100 },
      panes: [makePane(55, 100)],
      previous,
      cooldown,
      now: 1_000 + WINDOW_RESIZE_COOLDOWN_MS + 1,
    });
    expect(result).toBe(55);
    expect(cooldown.has(WINDOW_ID)).toBe(false);
  });

  it("ignores the enforcement echo via the suppression map", () => {
    const previous = snapshotSidebarWindows([makePane(20, 100)]);
    const suppressed = new Map<string, SidebarResizeSuppression>();
    suppressed.set(PANE_ID, { width: 40, expiresAt: 2_000 });

    const result = resolve({
      ctx: { paneId: PANE_ID, windowId: WINDOW_ID, width: 40, windowWidth: 100 },
      panes: [makePane(40, 100)],
      previous,
      suppressed,
      now: 1_000,
    });
    expect(result).toBeNull();
    expect(suppressed.has(PANE_ID)).toBe(false);
  });
});
