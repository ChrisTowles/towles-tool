import { persistAgentboardSetting, useSetting } from "./settings";

/** Built-in default for `agentboard.boardGroupByRepo` — grouped, today's look. */
const DEFAULT_BOARD_GROUP_BY_REPO = true;

const setGroupByRepo = (on: boolean) => persistAgentboardSetting("boardGroupByRepo", on);

/** The Board's group-by-repo-swimlane preference, live and write-through. */
export function useBoardGroupByRepo(): [boolean, (on: boolean) => void] {
  return [
    useSetting((s) => s.agentboard?.boardGroupByRepo, DEFAULT_BOARD_GROUP_BY_REPO),
    setGroupByRepo,
  ];
}
