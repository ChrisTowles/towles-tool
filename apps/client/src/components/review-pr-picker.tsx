// The new-task form's "Review PR" source: pick an open pull request (or type any
// number) and preflight it with `task_check_pr`, which answers the branch and dir
// the review task would get — its existing head, never a new branch.
import { Combobox } from "@cloudflare/kumo";
import { useEffect, useState } from "react";

import {
  type PrCheck,
  PrCheckSchema,
  type PullRequest,
  PullRequestsSchema,
} from "@/lib/schemas/task";
import { invoke } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";

/** `#12` or `12`, for a PR the open list doesn't show. */
export function parsePrNumber(text: string): number | null {
  const match = text.trim().match(/^#?(\d{1,9})$/);
  const n = match ? Number(match[1]) : 0;
  return n > 0 ? n : null;
}

type PrOption = { kind: "pr"; pr: PullRequest } | { kind: "typed"; number: number };

function matchesPr(option: PrOption, query: string): boolean {
  if (option.kind === "typed") return true;
  const { pr } = option;
  return `#${pr.number} ${pr.title} ${pr.author}`
    .toLowerCase()
    .includes(query.trim().toLowerCase());
}

export function ReviewPrPicker({
  root,
  check,
  onCheck,
}: {
  root: string;
  check: PrCheck | null;
  onCheck: (check: PrCheck | null) => void;
}) {
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [checking, setChecking] = useState<number | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPrs(null);
    setListError(null);
    void invoke("task_list_prs", { root }, { schema: PullRequestsSchema }).then((result) => {
      if (cancelled) return;
      result.match({ ok: setPrs, err: (e) => setListError(e.message) });
    });
    return () => {
      cancelled = true;
    };
  }, [root]);

  async function pick(number: number) {
    setSearch("");
    setChecking(number);
    setCheckError(null);
    onCheck(null);
    uiAction("task.pick_pr", "agentboard");
    const result = await invoke("task_check_pr", { root, number }, { schema: PrCheckSchema });
    setChecking(null);
    result.match({ ok: onCheck, err: (e) => setCheckError(e.message) });
  }

  const typed = parsePrNumber(search);
  const typedUnlisted = typed !== null && !prs?.some((pr) => pr.number === typed);
  const options: PrOption[] = [
    ...(typed !== null && typedUnlisted ? [{ kind: "typed" as const, number: typed }] : []),
    ...(prs ?? []).map((pr) => ({ kind: "pr" as const, pr })),
  ];
  const problem = checkError ?? check?.error ?? null;

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10.5px] text-kumo-subtle">pull request</span>
      <Combobox
        items={options}
        value={null}
        inputValue={search}
        onInputValueChange={setSearch}
        onValueChange={(next) => {
          const option = next as PrOption | null;
          if (!option) return;
          void pick(option.kind === "typed" ? option.number : option.pr.number);
        }}
        filter={matchesPr}
        size="sm"
      >
        <Combobox.TriggerValue className="w-full min-w-0 truncate text-xs">
          {checking !== null
            ? `Checking #${checking}…`
            : check
              ? `#${check.pr.number} ${check.pr.title}`
              : "Pick a pull request to review"}
        </Combobox.TriggerValue>
        <Combobox.Content className="w-80">
          {listError && <p className="p-3 text-[11px] text-red-500">{listError}</p>}
          <Combobox.Input
            aria-label="Search pull requests"
            placeholder="Search open PRs, or type a number…"
            className="text-xs"
          />
          <Combobox.Empty>
            {prs === null && !listError ? "Loading pull requests…" : "No open pull requests."}
          </Combobox.Empty>
          <Combobox.List>
            {(option: PrOption) =>
              option.kind === "typed" ? (
                <Combobox.Item key="typed" value={option}>
                  <span className="text-xs">Review PR #{option.number}</span>
                </Combobox.Item>
              ) : (
                <Combobox.Item key={option.pr.number} value={option}>
                  <span className="block w-full truncate text-xs">{option.pr.title}</span>
                  <span className="block text-[10.5px] text-kumo-subtle">
                    #{option.pr.number} · {option.pr.author}
                    {option.pr.isDraft ? " · draft" : ""}
                    {option.pr.crossRepository ? " · fork" : ""}
                  </span>
                </Combobox.Item>
              )
            }
          </Combobox.List>
        </Combobox.Content>
      </Combobox>
      {check && !problem && (
        <p className="truncate font-mono text-[10.5px] text-kumo-subtle">
          {check.branch} → {check.pr.baseBranch}
        </p>
      )}
      {problem && <p className="text-[10.5px] text-red-500">{problem}</p>}
    </div>
  );
}
