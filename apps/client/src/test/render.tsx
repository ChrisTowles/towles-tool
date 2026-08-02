// Shared harness for render-level component tests (`*.test.tsx`, jsdom env), not
// itself a test file. jsdom has no `__TAURI_INTERNALS__`, so every `invoke` returns
// `NotInTauri` and each component paints its browser-dev fallback — the backend seam.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkspaceProvider } from "@/lib/workspace";
import { NowProvider } from "@/lib/now";
import { StoreSnapshotProvider } from "@/lib/store-snapshot";
import { AgentboardStateProvider } from "@/lib/agentboard-state";

// jsdom omits a few browser APIs that ThemeProvider (matchMedia) and the
// vendored Radix primitives (ResizeObserver, pointer capture, scrollIntoView)
// reach for on mount. Stub them so a plain render doesn't throw.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

function AllProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <WorkspaceProvider>
        <NowProvider>
          <StoreSnapshotProvider>
            <AgentboardStateProvider>
              <TooltipProvider>{children}</TooltipProvider>
            </AgentboardStateProvider>
          </StoreSnapshotProvider>
        </NowProvider>
      </WorkspaceProvider>
    </ThemeProvider>
  );
}

/** Render a component wrapped in the app's provider tree. */
export function renderWithProviders(ui: ReactElement) {
  return render(ui, { wrapper: AllProviders });
}
