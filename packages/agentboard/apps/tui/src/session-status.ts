import type { SessionData } from "@tt-agentboard/runtime";
import type { SessionStatusCounts } from "./components/StatusBar";

export function computeSessionStatusCounts(sessions: SessionData[]): SessionStatusCounts {
  let active = 0;
  let error = 0;
  let idle = 0;
  for (const s of sessions) {
    const status = s.agentState?.status;
    if (status === "running" || status === "waiting" || status === "question") {
      active++;
    } else if (status === "error") {
      error++;
    } else {
      idle++;
    }
  }
  return { active, error, idle };
}
