// Shared harness for render-level component tests (`*.test.tsx`, jsdom env), not
// itself a test file. jsdom has no `__TAURI_INTERNALS__`, so every `invoke` returns
// `NotInTauri` and each component paints its browser-dev fallback — the backend seam.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { TooltipProvider } from "@cloudflare/kumo";
import { RegistryContext } from "@effect/atom-react";
import { appRegistry } from "@/lib/atoms/registry";

// jsdom omits a few browser APIs that lib/theme (matchMedia) and the Base UI
// primitives (ResizeObserver, pointer capture, scrollIntoView, getAnimations)
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
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};

afterEach(() => {
  cleanup();
  // Atoms are app state: each test starts from their initial values.
  appRegistry.reset();
});

function AllProviders({ children }: { children: ReactNode }) {
  return (
    <RegistryContext.Provider value={appRegistry}>
      <TooltipProvider>{children}</TooltipProvider>
    </RegistryContext.Provider>
  );
}

/** Render a component wrapped in the app's provider tree. */
export function renderWithProviders(ui: ReactElement) {
  return render(ui, { wrapper: AllProviders });
}
