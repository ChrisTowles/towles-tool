// A goal and a base branch (or, reviewing, an open PR's head) become a worktree via
// `task_create`. Submit hands off without awaiting, binding the worktree dir so the
// rail row is on screen before the git work runs.
import {
  ArrowUUpLeftIcon,
  CaretDownIcon,
  CheckIcon,
  ImageSquareIcon,
  RecordIcon,
  SparkleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { Button, Checkbox, Combobox, Input, Popover, Select } from "@cloudflare/kumo";
import {
  ClaudeEffort,
  ClaudeLaunchOptions,
  ClaudeModel,
  PastedImage,
  clipboardImageFromHost,
  imagesFromDataTransfer,
  isPasteableImage,
  nextDraftScopeId,
} from "@/lib/agentboard";
import { IssueItem, storeGhIssuesList } from "@/lib/data";
import { GoalEditor } from "@/components/goal-editor";
import { ImageLightbox } from "@/components/image-lightbox";
import { referencedIssueNumbers } from "@/lib/goal-text";
import { loadUserSettings, type PromptImprover } from "@/lib/settings";
import {
  type BaseBranch,
  BaseBranchesSchema,
  PastedImagePathsSchema,
  type PrCheck,
  type PullRequest,
} from "@/lib/schemas/task";
import { ReviewPrPicker } from "@/components/review-pr-picker";
import { invoke } from "@/lib/tauri";
import { matchesShortcut } from "@/lib/shortcuts";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";
import { slugify } from "@/lib/slug";

/** Passes no `--model`/`--effort`, so the user's own Claude config decides. */
const USE_DEFAULT = "default";

type ModelChoice = ClaudeModel | typeof USE_DEFAULT;
type EffortChoice = ClaudeEffort | typeof USE_DEFAULT;

const MODEL_OPTIONS: { value: ModelChoice; label: string }[] = [
  { value: USE_DEFAULT, label: "Default model" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "fable", label: "Fable" },
];

const EFFORT_OPTIONS: { value: EffortChoice; label: string }[] = [
  { value: USE_DEFAULT, label: "Default effort" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];

export type NewTaskRepo = {
  name: string;
  dir: string;
  key: string;
  /** Parsed to `owner/name`, so the new task's binding can auto-attach PRs. */
  originUrl?: string | null;
};

/** Empty `prompt` makes the backend use `tt_tasks::DEFAULT_SUGGEST_INSTRUCTION`. */
const FALLBACK_IMPROVER: PromptImprover = {
  id: "direct",
  label: "Suggest name + goal",
  enabled: true,
  preferred: true,
  prompt: "",
};

export type NewTaskSubmit = {
  goal: string;
  /** A peer of `branch`, not derived from it: only the rail shows this. */
  title: string;
  branch: string;
  base: string;
  options: ClaudeLaunchOptions;
  /** Paths of images already staged to disk at paste time, not the bytes. */
  imagePaths: string[];
  issues: IssueItem[];
  /** Bound at submit so the rail row exists before `git worktree add` runs.
   * `null` until the preflight answers. */
  dir: string | null;
  /** False for "Task only": create the board task but no worktree/agent. */
  worktree: boolean;
  /** False leaves the PTY at a bare shell — no `claude` line typed. */
  launchClaude: boolean;
  /** Set for a review task: `task_create` checks out this PR's head instead. */
  pr: PullRequest | null;
};

/** Mirrors the Rust `TaskCreated` payload from `task_create`. */
export type TaskCreated = {
  name: string;
  dir: string;
  branch: string;
  base: string;
  warnings: string[];
};

/** Mirrors the Rust `BranchCheck` payload from `task_check_branch`. */
export type BranchCheck = {
  name: string | null;
  /** Derived from the branch, so it is known before anything is created. */
  dir: string | null;
  taken: boolean;
  branchExists: boolean;
  error: string | null;
};

/** Mirrors the Rust `TaskSuggestion` payload from `task_suggest`. */
export type TaskSuggestion = {
  branch: string;
  title: string;
  goal: string;
  /** Set when a local slug filled the fields — a note, not an error. */
  fallback: string | null;
};

export const BRANCH_SLUG_SOURCE_CHARS = 50;

/** Per `repo.key`: a repo you triage wants a different default from one where
 * only your own issues matter. */
function issueScopeKey(repoKey: string): string {
  return `tt-new-task-issue-mine:${repoKey}`;
}

function loadIssueScopeMine(repoKey: string): boolean {
  return localStorage.getItem(issueScopeKey(repoKey)) === "true";
}

function saveIssueScopeMine(repoKey: string, mine: boolean): void {
  localStorage.setItem(issueScopeKey(repoKey), String(mine));
}

/** A default only; the branch field stays editable. */
function IssueList({
  issues,
  isSelected,
  onToggle,
}: {
  issues: IssueItem[];
  isSelected: (issue: IssueItem) => boolean;
  onToggle: (issue: IssueItem) => void;
}) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const shown = issues.filter((i) => `${i.number} ${i.title}`.toLowerCase().includes(needle));
  return (
    <div className="flex flex-col gap-1 p-1">
      <Input
        aria-label="Search issues"
        size="xs"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search issues…"
      />
      <div className="max-h-64 overflow-y-auto">
        {shown.length === 0 && <p className="p-3 text-xs text-kumo-subtle">No open issues.</p>}
        {shown.map((issue) => (
          <button
            key={issue.number}
            type="button"
            onClick={() => onToggle(issue)}
            className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-kumo-tint"
          >
            <CheckIcon
              className={cn("mt-0.5 size-3 shrink-0", !isSelected(issue) && "invisible")}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="w-full truncate text-xs">{issue.title}</span>
              <span className="text-[10.5px] text-kumo-subtle">
                #{issue.number}
                {issue.labels.length > 0 ? ` · ${issue.labels.slice(0, 2).join(", ")}` : ""}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function goalToBranch(goal: string): string {
  const slug = slugify(goal.slice(0, BRANCH_SLUG_SOURCE_CHARS));
  return slug ? `feat/${slug}` : "";
}

/** Mirrors `tt_tasks::suggest`'s `TITLE_MAX_CHARS`. */
export const TITLE_MAX_CHARS = 60;

/** Cut at a word boundary and never slugged: a title is prose, not a git ref. */
export function goalToTitle(goal: string): string {
  const trimmed = goal.trim();
  if (trimmed.length <= TITLE_MAX_CHARS) return trimmed;
  const cut = trimmed.slice(0, TITLE_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}

/** `feat/`, not tt-git's `feature/` (Cockpit's convention), so a picked issue
 * and a typed goal produce the same shape. */
export function branchFromIssue(number: number, title: string): string {
  const slug = slugify(title.slice(0, BRANCH_SLUG_SOURCE_CHARS));
  return slug ? `feat/${number}-${slug}` : `feat/${number}`;
}

/** Seeded into an empty goal on a PR pick; editable like any other goal. */
export function reviewGoal(pr: PullRequest): string {
  return `Review PR #${pr.number}: ${pr.title}`;
}

export function InlineNewTask({
  repo,
  onCancel,
  onSubmit,
  initialGoal,
}: {
  repo: NewTaskRepo;
  onCancel: () => void;
  onSubmit: (input: NewTaskSubmit) => void;
  /** Set when the form was opened to reopen a closed task, not start a new one. */
  initialGoal?: string;
}) {
  const [goal, setGoal] = useState(initialGoal ?? "");
  const [images, setImages] = useState<PastedImage[]>([]);
  // Staged on paste, not at submit: an improver needs real paths to hand
  // `claude -p`, and staging once keeps create and suggest on the same files.
  const [imagePaths, setImagePaths] = useState<string[]>([]);
  // By id, not index — see `ImageLightbox` for why.
  const [zoomedImageId, setZoomedImageId] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);
  // The branch can't key the staging dir — it's still being edited on paste.
  const [draftScope] = useState(nextDraftScopeId);
  const [branchEdit, setBranchEdit] = useState<string | null>(null);
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [base, setBase] = useState("");
  const [model, setModel] = useState<ModelChoice>(USE_DEFAULT);
  const [effort, setEffort] = useState<EffortChoice>(USE_DEFAULT);
  const [improvers, setImprovers] = useState<PromptImprover[]>([FALLBACK_IMPROVER]);
  const [moreOpen, setMoreOpen] = useState(false);
  // On by default; unchecking is the "I just want the worktree" escape hatch.
  const [launchClaude, setLaunchClaude] = useState(true);
  const [branches, setBranches] = useState<BaseBranch[]>([]);
  // One slot, so no `showError` has to remember to clear the other.
  const [notice, setNotice] = useState<{ text: string; kind: "error" | "note" } | null>(null);
  const showError = (text: string) => setNotice({ text, kind: "error" });
  const [branchCheck, setBranchCheck] = useState<BranchCheck | null>(null);
  // Which improver is running, so only its own button says so.
  const [suggesting, setSuggesting] = useState<string | null>(null);
  const [preOverwrite, setPreOverwrite] = useState<{
    goal: string;
    branchEdit: string | null;
    titleEdit: string | null;
  } | null>(null);
  const [issuePickerOpen, setIssuePickerOpen] = useState(false);
  // Set by either issue path (popover or the goal field's `#`), so `gh` is
  // shelled once, on first need, either way.
  const [issuesWanted, setIssuesWanted] = useState(false);
  const [issueAssignedToMe, setIssueAssignedToMeState] = useState(() =>
    loadIssueScopeMine(repo.key),
  );
  const [issues, setIssues] = useState<IssueItem[] | null>(null);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [selectedIssues, setSelectedIssues] = useState<IssueItem[]>([]);
  const [mode, setMode] = useState<"new" | "review">("new");
  const [prCheck, setPrCheck] = useState<PrCheck | null>(null);
  const reviewing = mode === "review";

  const sortedBranches = [...branches].toSorted((a, b) => a.name.localeCompare(b.name));

  // The selected branch's honest label (`origin/main` when that's what creation
  // will branch from), falling back to the raw value until the list loads.
  const baseLabel = branches.find((b) => b.name === base)?.label ?? (base || "main");

  const branch = branchEdit ?? goalToBranch(goal);
  const title = titleEdit ?? goalToTitle(goal);

  useEffect(() => {
    let cancelled = false;
    void invoke<BaseBranch[]>(
      "task_base_branches",
      { root: repo.dir },
      { schema: BaseBranchesSchema },
    ).then((result) => {
      if (cancelled) return;
      result.match({
        ok: (list) => {
          setBranches(list);
          setBase(list[0]?.name ?? "main");
        },
        err: (e) => showError(e.message),
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-fetch only on a changed repo; showError is stable and the setters are React-stable
  }, [repo.dir]);

  useEffect(() => {
    let cancelled = false;
    void loadUserSettings().then((s) => {
      if (cancelled) return;
      const enabled = (s?.promptImprovers ?? []).filter((t) => t.enabled);
      setImprovers(enabled.length > 0 ? enabled : [FALLBACK_IMPROVER]);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced preflight: legal ref, no colliding task name. Read-only, so it
  // can fire on every settled keystroke.
  useEffect(() => {
    if (!branch) {
      setBranchCheck(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void invoke<BranchCheck>("task_check_branch", { root: repo.dir, branch }).then((check) => {
        if (!cancelled) setBranchCheck(check.unwrapOr(null));
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [repo.dir, branch]);

  function cancel() {
    onCancel();
  }

  const branchProblem =
    branchCheck?.error ??
    (branchCheck?.taken ? `a task named "${branchCheck.name}" already exists` : null) ??
    (branchCheck?.branchExists ? `a branch named "${branch.trim()}" already exists` : null);

  // Preferred get their own button, the rest sit under "More" — unless none are
  // preferred, where an empty row would be strictly worse.
  const anyPreferred = improvers.some((i) => i.preferred);
  const preferredImprovers = anyPreferred ? improvers.filter((i) => i.preferred) : improvers;
  const otherImprovers = anyPreferred ? improvers.filter((i) => !i.preferred) : [];
  const improverDisabled =
    suggesting !== null || staging || (!goal.trim() && imagePaths.length === 0);

  // Manual only, never a timer. Fills the editable fields directly: staying
  // editable, with Undo, *is* the confirmation step.
  async function runImprover(improver: PromptImprover) {
    // A screenshot is a complete brief on its own, so images alone can ask.
    if (suggesting || (!goal.trim() && !imagePaths.length)) return;
    setMoreOpen(false);
    setSuggesting(improver.id);
    setNotice(null);
    uiAction("task.improve_prompt", "agentboard", improver.id);
    const suggestion = await invoke<TaskSuggestion>("task_suggest", {
      dir: repo.dir,
      goal,
      imagePaths,
      instruction: improver.prompt,
    });
    suggestion.match({
      ok: (s) => {
        setPreOverwrite({ goal, branchEdit, titleEdit });
        setGoal(s.goal);
        setBranchEdit(s.branch);
        setTitleEdit(s.title);
        if (s.fallback) {
          setNotice({ text: `Filled in without claude — ${s.fallback}`, kind: "note" });
        }
      },
      err: (e) => showError(e.message),
    });
    setSuggesting(null);
  }

  function undoOverwrite() {
    if (!preOverwrite) return;
    setGoal(preOverwrite.goal);
    setBranchEdit(preOverwrite.branchEdit);
    setTitleEdit(preOverwrite.titleEdit);
    setPreOverwrite(null);
    setNotice(null);
  }

  function setIssueAssignedToMe(mine: boolean) {
    setIssueAssignedToMeState(mine);
    saveIssueScopeMine(repo.key, mine);
  }

  // Only once the picker opens — this shells `gh`.
  useEffect(() => {
    if (!issuesWanted) return;
    let cancelled = false;
    setIssues(null);
    setIssuesError(null);
    void storeGhIssuesList(repo.dir, issueAssignedToMe).then((result) => {
      if (cancelled) return;
      result.match({ ok: setIssues, err: (e) => setIssuesError(e.message) });
    });
    return () => {
      cancelled = true;
    };
  }, [issuesWanted, issueAssignedToMe, repo.dir]);

  /** Attaches without touching the fields — the `#` mention already wrote
   * what the user typed. Idempotent: `#12` twice attaches once. */
  function attachIssue(issue: IssueItem) {
    setSelectedIssues((prev) =>
      prev.some((i) => i.repo === issue.repo && i.number === issue.number)
        ? prev
        : [...prev, issue],
    );
  }

  // The *first* pick also seeds goal + branch, with the same Undo as an
  // improver; later picks only attach, so an edited goal survives.
  function toggleIssue(issue: IssueItem) {
    const already = selectedIssues.some((i) => i.repo === issue.repo && i.number === issue.number);
    if (already) {
      setSelectedIssues((prev) =>
        prev.filter((i) => !(i.repo === issue.repo && i.number === issue.number)),
      );
      return;
    }
    if (selectedIssues.length === 0) {
      setPreOverwrite({ goal, branchEdit, titleEdit });
      setGoal(`${issue.title} (#${issue.number})`);
      setBranchEdit(branchFromIssue(issue.number, issue.title));
      setTitleEdit(issue.title);
    }
    setSelectedIssues((prev) => [...prev, issue]);
  }

  // Bytes are staged outside the repo (`tt_tasks::pasted`). Two paths can
  // attach the same image, so adding is idempotent on the bytes.
  async function addImages(incoming: PastedImage[]) {
    if (!incoming.length) return;
    const seen = new Set(images.map((i) => i.dataBase64));
    const fresh = incoming.filter((i) => !seen.has(i.dataBase64));
    if (!fresh.length) return;
    const next = [...images, ...fresh];
    setImages(next);
    setNotice(null);
    await stageImages(next);
  }

  /** Fails loudly: the image looks attached, so a missing file would otherwise
   * surface only as a prompt pointing at nothing. */
  async function stageImages(list: PastedImage[]) {
    if (!list.length) {
      setImagePaths([]);
      return;
    }
    setStaging(true);
    const staged = await invoke<string[]>(
      "task_write_pasted_images",
      {
        repo: repo.name,
        branch: draftScope,
        images: list.map(({ mime, dataBase64 }) => ({ mime, dataBase64 })),
      },
      { schema: PastedImagePathsSchema },
    );
    staged.match({
      ok: setImagePaths,
      err: (e) => {
        setImages([]);
        setImagePaths([]);
        showError(`Couldn't attach that image: ${e.message}`);
      },
    });
    setStaging(false);
  }

  async function pasteImages(data: DataTransfer | null) {
    (await imagesFromDataTransfer(data)).match({
      ok: (imgs) => void addImages(imgs),
      err: (e) => showError(e.message),
    });
  }

  // The *primary* path, not a fallback: WebKitGTK delivers an image paste with
  // empty `clipboardData`, and Ctrl+V there may fire no `paste` event at all.
  async function pasteFromHostClipboard(): Promise<boolean> {
    const image = await clipboardImageFromHost();
    if (!image) return false;
    await addImages([image]);
    return true;
  }

  function removeImage(id: string) {
    const next = images.filter((img) => img.id !== id);
    setImages(next);
    if (zoomedImageId === id) setZoomedImageId(null);
    // Restage, or the removed image stays on disk and still lands in the prompt.
    void stageImages(next);
  }

  /** Folds any `#N` typed in the goal into the attach list, so naming an issue
   * needs no Pick-issue step. Matched against the already-loaded list only: no
   * `gh` round-trip at submit, and a no-op before anything has loaded. */
  function reconcileGoalIssueRefs(): IssueItem[] {
    if (!issues) return selectedIssues;
    const already = new Set(selectedIssues.map((i) => `${i.repo}#${i.number}`));
    const additions = referencedIssueNumbers(goal)
      .map((n) => issues.find((i) => i.number === n))
      .filter((i): i is IssueItem => i !== undefined && !already.has(`${i.repo}#${i.number}`));
    return additions.length > 0 ? [...selectedIssues, ...additions] : selectedIssues;
  }

  function pickPr(check: PrCheck | null) {
    setPrCheck(check);
    if (check && !goal.trim()) setGoal(reviewGoal(check.pr));
  }

  function switchMode(next: "new" | "review") {
    if (next === mode) return;
    uiAction("task.form_mode", "agentboard", next);
    setMode(next);
    setNotice(null);
  }

  function submitReview() {
    if (!prCheck) {
      showError("Pick a pull request first.");
      return;
    }
    // Already shown under the picker.
    if (prCheck.error) return;
    uiAction(launchClaude ? "task.review_pr" : "task.review_pr_no_claude", "agentboard");
    onSubmit({
      goal: goal.trim(),
      title: goalToTitle(goal || reviewGoal(prCheck.pr)).replace(/[\s:—–-]+$/, ""),
      branch: prCheck.branch,
      base: prCheck.pr.baseBranch,
      options: {
        model: model === USE_DEFAULT ? undefined : model,
        effort: effort === USE_DEFAULT ? undefined : effort,
      },
      imagePaths,
      issues: [],
      dir: prCheck.dir,
      worktree: true,
      launchClaude,
      pr: prCheck.pr,
    });
  }

  function submit(worktree = true) {
    if (reviewing) {
      submitReview();
      return;
    }
    const issuesToAttach = reconcileGoalIssueRefs();
    if (worktree) {
      if (!branch) {
        showError("Give a goal (or type a branch name) first.");
        return;
      }
      if (branchProblem) {
        // Already shown inline under the branch field.
        return;
      }
    } else if (!goal.trim() && issuesToAttach.length === 0) {
      // A task-only create still needs *something* to become the card.
      showError("Give a goal (or pick an issue) first.");
      return;
    }
    const action = !worktree
      ? "task.create_only"
      : launchClaude
        ? "task.start"
        : "task.start_no_claude";
    uiAction(action, "agentboard");
    onSubmit({
      goal: goal.trim(),
      title: title.trim() || branch,
      branch,
      base,
      options: {
        model: model === USE_DEFAULT ? undefined : model,
        effort: effort === USE_DEFAULT ? undefined : effort,
      },
      imagePaths,
      issues: issuesToAttach,
      dir: branchCheck?.dir ?? null,
      worktree,
      launchClaude,
      pr: null,
    });
  }

  return (
    <div className="mx-3 my-1.5 flex flex-col gap-2 rounded-lg border border-kumo-hairline bg-card p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-kumo-subtle">✦ New task — {repo.name}</span>
        <div className="flex rounded-md border border-kumo-hairline p-px" role="group">
          {(
            [
              ["new", "New work"],
              ["review", "Review PR"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => switchMode(value)}
              className={cn(
                "rounded-[5px] px-1.5 py-0.5 text-[10.5px] text-kumo-subtle hover:text-kumo-default",
                mode === value && "bg-accent text-kumo-default",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {reviewing && <ReviewPrPicker root={repo.dir} check={prCheck} onCheck={pickPr} />}
      <GoalEditor
        autoFocus
        value={goal}
        onChange={setGoal}
        issues={issues}
        issuesError={issuesError}
        onNeedIssues={() => setIssuesWanted(true)}
        onPickIssue={attachIssue}
        onPaste={(e) => {
          const items = Array.from(e.clipboardData?.items ?? []);
          const pastedImages = items.filter(
            (it) => it.kind === "file" && it.type.startsWith("image/"),
          );
          if (pastedImages.length) {
            e.preventDefault();
            // preventDefault already swallowed it, so an unwritable type (SVG)
            // must say why rather than vanish.
            if (!pastedImages.some((it) => isPasteableImage(it.type))) {
              showError(`Can't attach ${pastedImages[0].type} — paste a PNG, JPEG, GIF, or WebP.`);
              return;
            }
            void pasteImages(e.clipboardData);
            return;
          }
          // `getData`, not `items` — that is what WebKitGTK populates.
          if (e.clipboardData?.getData("text")) return;
          // Empty is what a WebKitGTK image paste looks like, so ask the OS.
          e.preventDefault();
          void pasteFromHostClipboard();
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          if (!Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === "file")) return;
          e.preventDefault();
          void pasteImages(e.dataTransfer);
        }}
        onKeyDown={(e) => {
          if (matchesShortcut("ab-start-task", e.nativeEvent)) {
            e.preventDefault();
            uiAction("shortcut.ab-start-task", "agentboard");
            submit();
          }
          if (e.key === "Escape") cancel();
          // No preventDefault: a text paste must still land natively.
          if (e.key.toLowerCase() === "v" && (e.metaKey || e.ctrlKey)) {
            void pasteFromHostClipboard();
          }
        }}
        hint="paste or drop a screenshot to attach it"
        placeholder={
          reviewing ? "what should the review focus on?" : "what should this task get done?"
        }
        rows={2}
      />
      {selectedIssues.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedIssues.map((issue) => (
            <span
              key={`${issue.repo}#${issue.number}`}
              title={issue.title}
              className="flex items-center gap-1 rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 font-mono text-[10.5px] text-kumo-subtle"
            >
              #{issue.number}
              <button
                type="button"
                aria-label={`Detach issue #${issue.number}`}
                onClick={() => toggleIssue(issue)}
                className="text-kumo-subtle hover:text-kumo-default"
              >
                <XIcon className="size-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((img) => (
            <div key={img.id} className="group relative">
              <button
                type="button"
                aria-label={`Zoom ${img.name}`}
                title={`${img.name} — attached to the new task's first prompt. Click to zoom.`}
                onClick={() => {
                  setZoomedImageId(img.id);
                  uiAction("task.image_zoom", "agentboard");
                }}
                className="block cursor-zoom-in rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <img
                  src={img.previewUrl}
                  alt={img.name}
                  className="size-12 rounded border border-kumo-hairline object-cover"
                />
              </button>
              <button
                type="button"
                aria-label={`Remove ${img.name}`}
                onClick={() => removeImage(img.id)}
                className="absolute -top-1 -right-1 rounded-full border border-kumo-hairline bg-kumo-base p-0.5 text-kumo-subtle opacity-0 transition-opacity group-hover:opacity-100 hover:text-kumo-default focus-visible:opacity-100"
              >
                <XIcon className="size-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <ImageLightbox images={images} openId={zoomedImageId} onOpenChange={setZoomedImageId} />
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="xs"
          className="mr-auto"
          icon={<ImageSquareIcon className="size-3" />}
          title="Attach the image currently on your clipboard"
          onClick={() => {
            void pasteFromHostClipboard().then((found) => {
              if (!found) showError("No image on the clipboard — copy one first.");
            });
          }}
        >
          Attach image
        </Button>
        {!reviewing && (
          <Popover
            open={issuePickerOpen}
            onOpenChange={(o) => {
              setIssuePickerOpen(o);
              if (o) setIssuesWanted(true);
            }}
          >
            <Popover.Trigger
              render={
                <Button variant="outline" size="xs" icon={<RecordIcon className="size-3" />}>
                  Pick issue
                </Button>
              }
            />
            <Popover.Content className="w-80 p-0" align="start">
              <div className="flex items-center justify-between gap-2 border-b border-kumo-hairline px-2 py-1.5">
                <span className="text-[10.5px] text-kumo-subtle">GitHub issues — {repo.name}</span>
                <button
                  type="button"
                  onClick={() => setIssueAssignedToMe(!issueAssignedToMe)}
                  className="text-[10.5px] font-medium text-primary hover:underline"
                >
                  {issueAssignedToMe ? "Show all open issues" : "Show only mine"}
                </button>
              </div>
              {issuesError ? (
                <p className="p-3 text-[11px] text-red-500">{issuesError}</p>
              ) : issues === null ? (
                <p className="p-3 text-[11px] text-kumo-subtle">Loading issues…</p>
              ) : (
                <IssueList
                  issues={issues}
                  isSelected={(issue) =>
                    selectedIssues.some((i) => i.repo === issue.repo && i.number === issue.number)
                  }
                  onToggle={toggleIssue}
                />
              )}
            </Popover.Content>
          </Popover>
        )}
        {!reviewing && preOverwrite && (
          <Button
            variant="ghost"
            size="xs"
            icon={<ArrowUUpLeftIcon className="size-3" />}
            onClick={undoOverwrite}
          >
            Undo
          </Button>
        )}
        {/* A split button: one per preferred improver, the rest behind the
            chevron segment attached to the last. */}
        {!reviewing &&
          preferredImprovers.map((improver, i) => (
            <Button
              key={improver.id}
              variant="outline"
              size="xs"
              className={cn(
                otherImprovers.length > 0 &&
                  i === preferredImprovers.length - 1 &&
                  "rounded-r-none",
              )}
              icon={<SparkleIcon className="size-3" />}
              title={improver.prompt || undefined}
              disabled={improverDisabled}
              onClick={() => void runImprover(improver)}
            >
              {suggesting === improver.id ? "Asking claude…" : improver.label}
            </Button>
          ))}
        {!reviewing && otherImprovers.length > 0 && (
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <Popover.Trigger
              render={
                <Button
                  variant="outline"
                  size="xs"
                  shape="square"
                  className="-ml-[9px] rounded-l-none border-l-0"
                  title="More prompt improvers — mark one Preferred in Settings to give it its own button"
                  disabled={improverDisabled}
                  aria-label="More prompt improvers"
                  icon={<CaretDownIcon className="size-3" />}
                />
              }
            />
            <Popover.Content className="w-56 p-1" align="end">
              {otherImprovers.map((improver) => (
                <button
                  key={improver.id}
                  type="button"
                  title={improver.prompt || undefined}
                  onClick={() => void runImprover(improver)}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs hover:bg-kumo-tint"
                >
                  <SparkleIcon className="size-3 shrink-0" />
                  <span className="truncate">
                    {suggesting === improver.id ? "Asking claude…" : improver.label}
                  </span>
                </button>
              ))}
            </Popover.Content>
          </Popover>
        )}
      </div>
      {!reviewing && (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-[10.5px] text-kumo-subtle">title</span>
            <Input
              aria-label="Task title"
              value={title}
              onChange={(e) => setTitleEdit(e.target.value)}
              size="sm"
              placeholder="auto-generated from your goal"
              className="min-w-0"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10.5px] text-kumo-subtle">branch</span>
            <Input
              aria-label="Branch name"
              value={branch}
              onChange={(e) => setBranchEdit(e.target.value)}
              size="sm"
              variant={branchProblem ? "error" : "default"}
              placeholder="auto-generated from your goal"
              className="min-w-0 font-mono"
            />
            {branchProblem && <p className="text-[10.5px] text-red-500">{branchProblem}</p>}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10.5px] text-kumo-subtle">base</span>
            <Combobox
              items={sortedBranches}
              value={branches.find((b) => b.name === base) ?? null}
              onValueChange={(next) => {
                const picked = next as BaseBranch | null;
                if (picked) setBase(picked.name);
              }}
              isItemEqualToValue={(a: BaseBranch, b: BaseBranch) => a.name === b.name}
              size="sm"
            >
              <Combobox.TriggerValue
                className="min-w-0 truncate font-mono text-xs"
                placeholder={baseLabel}
              />
              <Combobox.Content>
                <Combobox.Input aria-label="Search branches" placeholder="Search branches…" />
                <Combobox.Empty>No branches found.</Combobox.Empty>
                <Combobox.List>
                  {(b: BaseBranch) => (
                    <Combobox.Item key={b.name} value={b}>
                      <span className="block truncate font-mono text-xs">{b.label}</span>
                    </Combobox.Item>
                  )}
                </Combobox.List>
              </Combobox.Content>
            </Combobox>
          </div>
        </>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Select
          aria-label="Model"
          size="sm"
          className="w-full font-mono"
          value={model}
          onValueChange={(v) => setModel(v as ModelChoice)}
          items={MODEL_OPTIONS}
        />
        <Select
          aria-label="Effort"
          size="sm"
          className="w-full font-mono"
          value={effort}
          onValueChange={(v) => setEffort(v as EffortChoice)}
          items={EFFORT_OPTIONS}
        />
      </div>
      <label
        className="flex cursor-pointer items-start gap-2"
        title="Off: create the worktree and its terminal session but leave it at a bare shell — nothing is typed into the PTY. The goal still becomes the board card and the session's label."
      >
        <Checkbox
          aria-label="Start Claude on the goal"
          checked={launchClaude}
          onCheckedChange={(v) => setLaunchClaude(v)}
          className="mt-0.5"
        />
        <span className="text-[11px] leading-snug text-kumo-subtle">
          Start Claude on the goal — off leaves the new task at a bare shell
        </span>
      </label>
      {notice && (
        <p
          className={cn(
            "text-[11px]",
            notice.kind === "error" ? "text-red-500" : "text-kumo-subtle",
          )}
        >
          {notice.text}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
        {!reviewing && (
          <Button
            variant="outline"
            size="sm"
            title="Create the board task without a worktree — attach a task later by starting it again"
            disabled={!goal.trim() && selectedIssues.length === 0}
            onClick={() => submit(false)}
          >
            Task only
          </Button>
        )}
        {reviewing ? (
          <Button
            variant="primary"
            size="sm"
            disabled={!prCheck || !!prCheck.error}
            onClick={() => submit(true)}
          >
            Start review
          </Button>
        ) : (
          <Button variant="primary" size="sm" disabled={!branch} onClick={() => submit(true)}>
            Start task
          </Button>
        )}
      </div>
    </div>
  );
}
