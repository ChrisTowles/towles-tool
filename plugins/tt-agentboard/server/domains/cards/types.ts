export type Column = "backlog" | "ready" | "in_progress" | "review" | "done";
export type CardStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting_input"
  | "review_ready"
  | "done"
  | "failed"
  | "blocked";
