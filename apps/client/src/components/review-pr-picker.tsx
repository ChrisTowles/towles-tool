// The new-task form's "Review PR" source: pick an open pull request (or type any
// number) and preflight it with `task_check_pr`, which answers the branch and dir
// the review task would get — its existing head, never a new branch.
import { GitPullRequest } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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

export function ReviewPrPicker({
  root,
  check,
  onCheck,
}: {
  root: string;
  check: PrCheck | null;
  onCheck: (check: PrCheck | null) => void;
}) {
  const [open, setOpen] = useState(false);
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
    setOpen(false);
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
  const problem = checkError ?? check?.error ?? null;

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10.5px] text-muted-foreground">pull request</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="min-w-0 justify-start gap-1.5 truncate text-xs font-normal"
          >
            <GitPullRequest className="size-3 shrink-0" />
            <span className="truncate">
              {checking !== null
                ? `Checking #${checking}…`
                : check
                  ? `#${check.pr.number} ${check.pr.title}`
                  : "Pick a pull request to review"}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          {listError && <p className="p-3 text-[11px] text-red-500">{listError}</p>}
          <Command>
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder="Search open PRs, or type a number…"
              className="text-xs"
            />
            <CommandList className="max-h-64">
              <CommandEmpty>
                {prs === null && !listError ? "Loading pull requests…" : "No open pull requests."}
              </CommandEmpty>
              {typed !== null && typedUnlisted && (
                <CommandItem value={`#${typed} ${search}`} onSelect={() => void pick(typed)}>
                  <span className="text-xs">Review PR #{typed}</span>
                </CommandItem>
              )}
              {prs?.map((pr) => (
                <CommandItem
                  key={pr.number}
                  value={`#${pr.number} ${pr.title} ${pr.author}`}
                  onSelect={() => void pick(pr.number)}
                  className="flex flex-col items-start gap-0.5"
                >
                  <span className="w-full truncate text-xs">{pr.title}</span>
                  <span className="text-[10.5px] text-muted-foreground">
                    #{pr.number} · {pr.author}
                    {pr.isDraft ? " · draft" : ""}
                    {pr.crossRepository ? " · fork" : ""}
                  </span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {check && !problem && (
        <p className="truncate font-mono text-[10.5px] text-muted-foreground">
          {check.branch} → {check.pr.baseBranch}
        </p>
      )}
      {problem && <p className="text-[10.5px] text-red-500">{problem}</p>}
    </div>
  );
}
