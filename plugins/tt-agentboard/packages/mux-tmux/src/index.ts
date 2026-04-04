// Re-export TmuxClient and types from client module
export {
  TmuxClient,
  TmuxError,
  HOOK_NAMES,
  type TmuxClientOptions,
  type TmuxRunResult,
  type SessionInfo,
  type WindowInfo,
  type PaneInfo,
  type ClientInfo,
  type HookName,
  type PaneScope,
  type SplitWindowOptions,
} from "./client";

// Re-export TmuxProvider from provider module
export { TmuxProvider, SIDEBAR_PANE_TITLE, type TmuxProviderSettings } from "./provider";
