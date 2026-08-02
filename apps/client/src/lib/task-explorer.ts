import { invoke } from "@/lib/tauri";

/**
 * Bridge to `crates-tauri/tt-app/src/task_explorer.rs`: CPU/RAM for the app
 * plus each terminal's shell and its descendants.
 */

export type ProcessRow = {
  pid: number;
  parentPid: number | null;
  name: string;
  /** Percent of the whole machine's CPU (all cores). */
  cpuPercent: number;
  memoryBytes: number;
  status: string;
};

export type ProcessGroup = {
  /** `null` for the app's own process group. */
  termId: string | null;
  label: string;
  rows: ProcessRow[];
  totalCpuPercent: number;
  totalMemoryBytes: number;
};

export const taskExplorerSnapshot = () => invoke<ProcessGroup[]>("task_explorer_snapshot");
