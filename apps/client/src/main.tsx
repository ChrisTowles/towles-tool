import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import "./index.css";
import "@/lib/theme";
import { IS_MAC, installPcEditKeys, setPcKeybindings } from "@/lib/keymap";
import { RegistryContext } from "@effect/atom-react";
import { appRegistry, startAppEffects } from "@/lib/atoms/registry";
import { readSetting, userSettingsAtom } from "@/lib/settings";
import { fire, invoke } from "@/lib/tauri";
import { installConsoleCollector } from "@/lib/wdio-console";
import { installCrashReporter } from "@/lib/crash-report";
import { App } from "./App";

// E2E only: load the WebdriverIO Tauri plugin so tests get browser.tauri.execute /
// .mock. Gated on VITE_WDIO so it's tree-shaken out of normal/production bundles.
if (import.meta.env.VITE_WDIO) {
  // Synchronous, and before `createRoot` below: React reports invalid markup as
  // a console.error during the first render, so a dynamic import would install
  // the collector too late to catch the very warnings worth catching.
  installConsoleCollector();
  void import("@wdio/tauri-plugin");
}

// Before the first render, so a crash during it reaches the event log.
installCrashReporter();

// Mac only, before the first render: the keycaps, the native monitor and every
// workbench's keymap all wait on this read.
if (IS_MAC) {
  let pc: boolean | null = null;
  appRegistry.subscribe(userSettingsAtom, () => {
    const on = readSetting((s) => s.agentboard?.pcKeybindings, false);
    if (on === pc) return;
    pc = on;
    setPcKeybindings(on);
    fire(invoke("keymap_set_pc", { on }));
  });
  installPcEditKeys();
}

// Every backend feed (Tauri subscriptions, the settings file) starts once, here.
startAppEffects();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RegistryContext.Provider value={appRegistry}>
      {/* App-level motion policy, and deliberately only that: reducedMotion
          honors prefers-reduced-motion for every motion component at once, so
          no component hand-rolls motion-reduce classes. Per-animation tuning
          (durations, easings) belongs with the animation — see
          lib/rail-motion.ts — not in this global default.

          Yaak wraps this in <LazyMotion strict> to code-split motion's feature
          bundle, which is why their components use `m.*`. That split only
          works when every AnimatePresence consumer is behind a lazy chunk (its
          toasts/dialogs are). Ours isn't — the agentboard screen is statically
          imported — so a build puts motion in the initial chunk either way,
          and LazyMotion would buy nothing but the `m.*` ergonomic tax. */}
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </RegistryContext.Provider>
  </StrictMode>,
);
