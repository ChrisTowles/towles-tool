import type { DoctorRunResult } from "./checks.js";

export function formatDoctorJson(result: DoctorRunResult): string {
  return JSON.stringify(result, null, 2);
}
