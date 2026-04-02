import { debugLog } from "../debug";
import { saveConfig } from "../config";
import { resolveSidebarWidthFromResizeContext, snapshotSidebarWindows } from "./sidebar-width-sync";
import type { SidebarResizeContext } from "./sidebar-width-sync";
import type { ServerContext } from "./context";

const SIDEBAR_PANE_CACHE_TTL = 300; // ms

export function listSidebarPanesByProviderUncached(ctx: ServerContext) {
  return ctx.getProvidersWithSidebar().map((provider) => ({
    provider,
    panes: provider.listSidebarPanes(),
  }));
}

export function listSidebarPanesByProvider(ctx: ServerContext) {
  const now = Date.now();
  if (ctx.sidebarPaneCache && now - ctx.sidebarPaneCacheTs < SIDEBAR_PANE_CACHE_TTL)
    return ctx.sidebarPaneCache;
  ctx.sidebarPaneCache = listSidebarPanesByProviderUncached(ctx);
  ctx.sidebarPaneCacheTs = now;
  return ctx.sidebarPaneCache;
}

export function invalidateSidebarPaneCache(ctx: ServerContext): void {
  ctx.sidebarPaneCache = null;
  ctx.sidebarPaneCacheTs = 0;
}

export function scheduleSidebarResize(ctx: ServerContext, resizeCtx?: SidebarResizeContext): void {
  resizeSidebars(ctx, resizeCtx);
  if (ctx.pendingSidebarResize) clearTimeout(ctx.pendingSidebarResize);
  ctx.pendingSidebarResize = setTimeout(() => {
    ctx.pendingSidebarResize = null;
    resizeSidebars(ctx);
  }, 120);
}

export function toggleSidebar(
  ctx: ServerContext,
  toggleCtx?: { session: string; windowId: string },
): void {
  const providers = ctx.getProvidersWithSidebar();
  if (providers.length === 0) {
    debugLog("toggle", "SKIP — no providers with sidebar methods");
    return;
  }

  invalidateSidebarPaneCache(ctx);
  if (ctx.sidebarVisible) {
    for (const p of providers) {
      const panes = p.listSidebarPanes();
      debugLog("toggle", "OFF — hiding panes", { provider: p.name, count: panes.length });
      for (const pane of panes) {
        p.hideSidebar(pane.paneId);
      }
    }
    ctx.sidebarVisible = false;
  } else {
    ctx.sidebarVisible = true;
    for (const p of providers) {
      const allWindows = p.listActiveWindows();
      debugLog("toggle", "ON — spawning in active windows", {
        provider: p.name,
        count: allWindows.length,
      });
      for (const w of allWindows) {
        ensureSidebarInWindow(ctx, p, { session: w.sessionName, windowId: w.id });
      }
    }
    scheduleSidebarResize(ctx);
    ctx.server.publish("sidebar", JSON.stringify({ type: "re-identify" }));
  }
  debugLog("toggle", "done", { sidebarVisible: ctx.sidebarVisible });
}

export function ensureSidebarInWindow(
  ctx: ServerContext,
  provider?: ReturnType<ServerContext["getProvidersWithSidebar"]>[number],
  windowCtx?: { session: string; windowId: string },
): void {
  const p =
    provider ??
    (() => {
      const providers = ctx.getProvidersWithSidebar();
      if (windowCtx?.session) {
        const sessionProvider = ctx.sessionProviders.get(windowCtx.session);
        return providers.find((pp) => pp === sessionProvider) ?? providers[0];
      }
      return providers[0];
    })();
  if (!p || !ctx.sidebarVisible) {
    debugLog("ensure", "SKIP", { hasProvider: !!p, sidebarVisible: ctx.sidebarVisible });
    return;
  }

  const curSession = windowCtx?.session ?? ctx.getCurrentSession();
  if (!curSession) {
    debugLog("ensure", "SKIP — no current session");
    return;
  }

  const windowId = windowCtx?.windowId ?? p.getCurrentWindowId();
  if (!windowId) {
    debugLog("ensure", "SKIP — could not get window_id");
    return;
  }

  const spawnKey = `${p.name}:${windowId}`;
  if (ctx.pendingSidebarSpawns.has(spawnKey)) {
    debugLog("ensure", "SKIP — spawn already in progress", {
      curSession,
      windowId,
      provider: p.name,
    });
    return;
  }

  const allPanesByProvider = listSidebarPanesByProvider(ctx);
  const providerEntry = allPanesByProvider.find((e) => e.provider === p);
  const existingPanes = providerEntry?.panes ?? [];
  const hasInWindow = existingPanes.some((ep) => ep.windowId === windowId);
  debugLog("ensure", "checking window", {
    curSession,
    windowId,
    existingPanes: existingPanes.length,
    hasInWindow,
    paneIds: existingPanes.map((x) => `${x.paneId}@${x.windowId}`),
  });

  if (!hasInWindow) {
    invalidateSidebarPaneCache(ctx);
    ctx.pendingSidebarSpawns.add(spawnKey);
    debugLog("ensure", "SPAWNING sidebar", {
      curSession,
      windowId,
      sidebarWidth: ctx.sidebarWidth,
      sidebarPosition: ctx.sidebarPosition,
    });
    try {
      const newPaneId = p.spawnSidebar(curSession, windowId, ctx.sidebarWidth, ctx.sidebarPosition);
      debugLog("ensure", "spawn result", { newPaneId });
    } finally {
      ctx.pendingSidebarSpawns.delete(spawnKey);
    }
    scheduleSidebarResize(ctx);
  }
}

export function debouncedEnsureSidebar(
  ctx: ServerContext,
  windowCtx?: { session: string; windowId: string },
): void {
  if (windowCtx) ctx.ensureSidebarPendingCtx = windowCtx;
  if (ctx.ensureSidebarTimer) clearTimeout(ctx.ensureSidebarTimer);
  ctx.ensureSidebarTimer = setTimeout(() => {
    ctx.ensureSidebarTimer = null;
    const nextCtx = ctx.ensureSidebarPendingCtx;
    ctx.ensureSidebarPendingCtx = undefined;
    ensureSidebarInWindow(ctx, undefined, nextCtx);
  }, 150);
}

export function quitAll(ctx: ServerContext): void {
  debugLog("quit", "killing all sidebar panes");
  for (const p of ctx.getProvidersWithSidebar()) {
    const panes = p.listSidebarPanes();
    debugLog("quit", "found panes to kill", { provider: p.name, count: panes.length });
    for (const pane of panes) {
      p.killSidebarPane(pane.paneId);
    }
  }
  for (const p of ctx.getProvidersWithSidebar()) {
    p.cleanupSidebar();
  }
  ctx.server.publish("sidebar", JSON.stringify({ type: "quit" }));
  ctx.sidebarVisible = false;
  ctx.cleanup();
  process.exit(0);
}

export function resizeSidebars(ctx: ServerContext, resizeCtx?: SidebarResizeContext): void {
  const panesByProvider = listSidebarPanesByProvider(ctx);
  const allPanes = panesByProvider.flatMap(({ panes }) => panes);

  if (allPanes.length === 0) {
    ctx.sidebarSnapshots = new Map();
    return;
  }

  const nextSidebarWidth = resolveSidebarWidthFromResizeContext({
    ctx: resizeCtx,
    panes: allPanes,
    previousByWindow: ctx.sidebarSnapshots,
    suppressedByPane: ctx.suppressedSidebarResizeAcks,
  });

  if (nextSidebarWidth != null && nextSidebarWidth !== ctx.sidebarWidth) {
    ctx.sidebarWidth = nextSidebarWidth;
    saveConfig({ sidebarWidth: ctx.sidebarWidth });
    debugLog("resize", "adopted sidebar width from pane resize", {
      paneId: resizeCtx?.paneId ?? null,
      sessionName: resizeCtx?.sessionName ?? null,
      windowId: resizeCtx?.windowId ?? null,
      sidebarWidth: ctx.sidebarWidth,
    });
    ctx.broadcastState();
  }

  const now = Date.now();
  for (const { provider, panes } of panesByProvider) {
    debugLog("resize", "enforcing width on all panes", {
      provider: provider.name,
      sidebarWidth: ctx.sidebarWidth,
      count: panes.length,
      triggerPaneId: resizeCtx?.paneId ?? null,
    });
    for (const pane of panes) {
      if (pane.width === ctx.sidebarWidth) continue;
      ctx.suppressedSidebarResizeAcks.set(pane.paneId, {
        width: ctx.sidebarWidth,
        expiresAt: now + 1_000,
      });
      provider.resizeSidebarPane(pane.paneId, ctx.sidebarWidth);
    }
  }

  if (panesByProvider.some(({ panes }) => panes.some((pane) => pane.width !== ctx.sidebarWidth))) {
    invalidateSidebarPaneCache(ctx);
  }
  ctx.sidebarSnapshots = snapshotSidebarWindows(allPanes);
}
