import { loadConfig, saveConfig } from "@tt-agentboard/runtime";
import { MIN_DETAIL_PANEL_HEIGHT, DEFAULT_DETAIL_PANEL_HEIGHT } from "./constants";

export function clampDetailPanelHeight(height: number): number {
  return Math.max(MIN_DETAIL_PANEL_HEIGHT, Math.round(height));
}

export function getStoredDetailPanelHeight(sessionName: string): number {
  const stored = loadConfig().detailPanelHeights?.[sessionName];
  return typeof stored === "number" ? clampDetailPanelHeight(stored) : DEFAULT_DETAIL_PANEL_HEIGHT;
}

export function persistDetailPanelHeight(sessionName: string, height: number): void {
  const config = loadConfig();
  saveConfig({
    detailPanelHeights: {
      ...(config.detailPanelHeights ?? {}),
      [sessionName]: clampDetailPanelHeight(height),
    },
  });
}
