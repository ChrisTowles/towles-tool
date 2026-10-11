import type { WorkspaceScreen } from "./screens";

/** Which of the two workspace screens the one `CockpitScreen` is shown as, so
 * telemetry from the rows, menus and panes both share names the screen it was
 * clicked on. A click can only land while that screen is up, so the last mode
 * set is the right one; plain functions and hooks above any provider read it too. */
let current: WorkspaceScreen = "cockpit";

export function setWorkspaceScreen(screen: WorkspaceScreen): void {
  current = screen;
}

export function workspaceScreen(): WorkspaceScreen {
  return current;
}
