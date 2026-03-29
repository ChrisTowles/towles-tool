export type Column = "ready" | "in_progress" | "simplify_review" | "review" | "done" | "archived";
export type CardStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting_input"
  | "review_ready"
  | "done"
  | "failed"
  | "blocked";
