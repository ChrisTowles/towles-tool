import { useCallback } from "react";
import { persistAgentboardSetting, useLiveSetting } from "./settings";

/** Built-in default for `agentboard.boardGroupByRepo` — grouped, today's look. */
export const DEFAULT_BOARD_GROUP_BY_REPO = true;

/** The Board's group-by-repo-swimlane preference, live and write-through. */
export function useBoardGroupByRepo(): [boolean, (on: boolean) => void] {
  const [groupByRepo, setGroupByRepo] = useLiveSetting(
    (s) => s.agentboard?.boardGroupByRepo,
    DEFAULT_BOARD_GROUP_BY_REPO,
  );
  const persist = useCallback(
    (on: boolean) => {
      setGroupByRepo(on);
      void persistAgentboardSetting("boardGroupByRepo", on);
    },
    [setGroupByRepo],
  );
  return [groupByRepo, persist];
}
