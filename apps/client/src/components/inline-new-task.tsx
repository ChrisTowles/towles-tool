// Inline new-task flow: a goal and a base branch become a branch-named worktree
// (`task_create` → tt-tasks ops, shared with `tt task new`). It never blocks the
// rail — submit hands off to the caller and closes, binding the worktree dir so
// the row is on screen before the git work runs.
import { Check, ChevronDown, CircleDot, ImagePlus, Sparkles, Undo2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { type BaseBranch, BaseBranchesSchema, PastedImagePathsSchema } from "@/lib/schemas/task";
import { invoke } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";
import { slugify } from "@/lib/slug";

/** The unset state of the model/effort selects: no `--model`/`--effort` is
 * passed at all, so the user's own Claude config decides. Its own option
 * (rather than an empty value) because Radix `Select` can't represent "". */
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
  /** The repo's git origin URL when known — parsed to `owner/name` so the
   * created task's task binding can auto-attach PRs by branch. */
  originUrl?: string | null;
};

/** Fallback when settings can't be read or none are enabled. The empty `prompt`
 * makes the backend use `tt_tasks::DEFAULT_SUGGEST_INSTRUCTION`. */
const FALLBACK_IMPROVER: PromptImprover = {
  id: "direct",
  label: "Suggest name + goal",
  enabled: true,
  preferred: true,
  prompt: "",
};

/** What the new-task form hands its parent on submit. */
export type NewTaskSubmit = {
  goal: string;
  /** A peer of `branch`, not derived from it: the goal is Claude's launch
   * instructions, the title is only what the rail shows. */
  title: string;
  branch: string;
  base: string;
  options: ClaudeLaunchOptions;
  /** Absolute paths of the already-staged images, not the bytes — they were
   * written to disk when pasted. */
  imagePaths: string[];
  /** GitHub issues to attach to the created task (multi-select). */
  issues: IssueItem[];
  /** Bound onto the task row at submit so the rail row exists before `git
   * worktree add` runs. `null` until the preflight answers. */
  dir: string | null;
  /** False for "Task only": create the board task but no worktree/agent. */
  worktree: boolean;
  /** False leaves the PTY at a bare shell — no `claude` line typed. */
  launchClaude: boolean;
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
  /** Set when claude couldn't answer and a local slug filled the fields — a
   * note, not an error, so it renders muted. */
  fallback: string | null;
};

/** How much of the goal `goalToBranch` slugs into the branch name — long
 * enough to stay recognizable, short enough that the branch name doesn't
 * become a second copy of the whole goal. */
export const BRANCH_SLUG_SOURCE_CHARS = 50;

/** Issue-picker scope, per `repo.key` rather than one global toggle — a repo
 * you triage and a repo where only your own issues matter want different
 * defaults. "all" when unset: a task starts as often from someone else's
 * issue as from your own. */
function issueScopeKey(repoKey: string): string {
  return `tt-new-task-issue-mine:${repoKey}`;
}

function loadIssueScopeMine(repoKey: string): boolean {
  return localStorage.getItem(issueScopeKey(repoKey)) === "true";
}

function saveIssueScopeMine(repoKey: string, mine: boolean): void {
  localStorage.setItem(issueScopeKey(repoKey), String(mine));
}

/** Goal → branch name: the first `BRANCH_SLUG_SOURCE_CHARS` of the goal,
 * slugged, under a `feat/` prefix. The branch field stays editable — this is
 * just the default. */
export function goalToBranch(goal: string): string {
  const slug = slugify(goal.slice(0, BRANCH_SLUG_SOURCE_CHARS));
  return slug ? `feat/${slug}` : "";
}

/** Mirrors `tt_tasks::suggest`'s `TITLE_MAX_CHARS`, so the no-Claude default
 * matches what the suggest flow's local fallback produces. */
export const TITLE_MAX_CHARS = 60;

/** Goal → title default: the goal itself, cut at a word boundary — plain
 * words, never slugged (a title is prose, not a git ref). The title field
 * stays editable — this is just the default. */
export function goalToTitle(goal: string): string {
  const trimmed = goal.trim();
  if (trimmed.length <= TITLE_MAX_CHARS) return trimmed;
  const cut = trimmed.slice(0, TITLE_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}

/** `feat/<number>-<slug>` — this form's prefix, not tt-git's `feature/`
 * (Cockpit's convention, for an existing checkout), so a picked issue and a
 * typed goal produce the same shape. */
export function branchFromIssue(number: number, title: string): string {
  const slug = slugify(title.slice(0, BRANCH_SLUG_SOURCE_CHARS));
  return slug ? `feat/${number}-${slug}` : `feat/${number}`;
}

/** Embedded in the rail under the header whose "+" opened it. Submit hands the
 * input to `onSubmit` and closes without awaiting `task_create`, so the parent
 * can run it against the row the submit already created. */
export function InlineNewTask({
  repo,
  onCancel,
  onSubmit,
  initialGoal,
}: {
  repo: NewTaskRepo;
  onCancel: () => void;
  onSubmit: (input: NewTaskSubmit) => void;
  /** Pre-fills the goal field — set when this form was opened to reopen a
   * closed task (its text seeds the goal) rather than to start a new one. */
  initialGoal?: string;
}) {
  const [goal, setGoal] = useState(initialGoal ?? "");
  const [images, setImages] = useState<PastedImage[]>([]);
  // Staged on paste, not at submit: an improver needs real paths to hand
  // `claude -p`, and staging once keeps create and suggest on the same files.
  const [imagePaths, setImagePaths] = useState<string[]>([]);
  // Which attachment the full-size viewer is showing, by id — see
  // `ImageLightbox` for why it isn't an index.
  const [zoomedImageId, setZoomedImageId] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);
  // Stable per-form staging directory. The branch can't key it — it's still
  // being edited while images are pasted.
  const [draftScope] = useState(nextDraftScopeId);
  const [branchEdit, setBranchEdit] = useState<string | null>(null);
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [base, setBase] = useState("");
  // Both start unset — the launched `claude` gets no --model/--effort unless
  // the user explicitly picks one, so their own defaults apply.
  const [model, setModel] = useState<ModelChoice>(USE_DEFAULT);
  const [effort, setEffort] = useState<EffortChoice>(USE_DEFAULT);
  // Prompt improvers, loaded from settings and filtered to the enabled ones.
  const [improvers, setImprovers] = useState<PromptImprover[]>([FALLBACK_IMPROVER]);
  const [moreOpen, setMoreOpen] = useState(false);
  // Launching Claude on the goal is the whole point of the flow, so it's on
  // by default; unchecking it is the "I just want the worktree" escape hatch.
  const [launchClaude, setLaunchClaude] = useState(true);
  const [branches, setBranches] = useState<BaseBranch[]>([]);
  const [baseOpen, setBaseOpen] = useState(false);
  // One slot for an error or a note: mutually exclusive on screen, and two
  // would mean every `showError` had to remember to clear the other.
  const [notice, setNotice] = useState<{ text: string; kind: "error" | "note" } | null>(null);
  const showError = (text: string) => setNotice({ text, kind: "error" });
  const [branchCheck, setBranchCheck] = useState<BranchCheck | null>(null);
  // Only the clicked improver shows a running state; the rest just disable.
  const [suggesting, setSuggesting] = useState<string | null>(null);
  // What the fields held before the last overwrite, so "Undo" is exact.
  const [preOverwrite, setPreOverwrite] = useState<{
    goal: string;
    branchEdit: string | null;
    titleEdit: string | null;
  } | null>(null);
  const [issuePickerOpen, setIssuePickerOpen] = useState(false);
  // Set by either issue path — the Pick-issue popover or the goal field's `#`
  // autocomplete — so `gh` is shelled once, on first need, either way.
  const [issuesWanted, setIssuesWanted] = useState(false);
  // Lazy once from the stored preference — the form remounts per open.
  const [issueAssignedToMe, setIssueAssignedToMeState] = useState(() =>
    loadIssueScopeMine(repo.key),
  );
  const [issues, setIssues] = useState<IssueItem[] | null>(null);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  // Multi-select; the first pick also seeds the goal/branch fields.
  const [selectedIssues, setSelectedIssues] = useState<IssueItem[]>([]);

  const sortedBranches = [...branches].toSorted((a, b) => a.name.localeCompare(b.name));
  // What the closed combobox shows: the selected branch's honest label (e.g.
  // `origin/main` when that's what creation will branch from), falling back
  // to the raw value before the branch list has loaded.
  const baseLabel = branches.find((b) => b.name === base)?.label ?? (base || "main");

  const branch = branchEdit ?? goalToBranch(goal);
  const title = titleEdit ?? goalToTitle(goal);

  useEffect(() => {
    // Guards a fast close-then-reopen against a stale fetch's `.then`.
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
    // Re-fetch only on a changed repo; a mount is an open.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-fetch only on a changed repo; showError is stable and the setters are React-stable
  }, [repo.dir]);

  // Once per open, from the same file Settings writes — an improver edited
  // there shows up on the next open. Never an empty row: see the fallback.
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

  // Debounced preflight: legal ref, and no colliding task name. Read-only,
  // so it can fire on every settled keystroke.
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

  // Preferred get their own button, the rest sit under "More" — unless none
  // are preferred, where an empty row would be strictly worse.
  const anyPreferred = improvers.some((i) => i.preferred);
  const preferredImprovers = anyPreferred ? improvers.filter((i) => i.preferred) : improvers;
  const otherImprovers = anyPreferred ? improvers.filter((i) => !i.preferred) : [];
  // Same gate the single Suggest button had: nothing to rewrite, mid-stage, or
  // another improver already running.
  const improverDisabled =
    suggesting !== null || staging || (!goal.trim() && imagePaths.length === 0);

  // Manual only — never a timer or a keystroke. Asks `claude -p` (cwd = the
  // repo, for real context) to rewrite the goal per `improver.prompt` and fills
  // the editable fields directly: staying editable, with Undo, *is* the
  // confirmation step, and the launch path needs no improver knowledge.
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

  // Loads only once the picker opens — a task is created far more often by
  // typing a goal, and this shells `gh`.
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

  /** Attach without touching the fields — the `#` autocomplete already wrote
   * what the user typed. Idempotent: `#12` twice attaches once. */
  function attachIssue(issue: IssueItem) {
    setSelectedIssues((prev) =>
      prev.some((i) => i.repo === issue.repo && i.number === issue.number)
        ? prev
        : [...prev, issue],
    );
  }

  // The *first* pick also seeds goal + branch — same overwrite-with-Undo shape
  // as `suggest()`; later picks only attach, so an edited goal survives. Title
  // and number are all there is to seed with (the list carries no body), and
  // the number lets Claude `gh issue view` the rest.
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

  // The goal field takes an image paste directly; bytes are staged outside the
  // repo (`tt_tasks::pasted`) and their paths go into Claude's opening prompt.
  // Two paths can attach the same image (the DOM event and the host-clipboard
  // read below), so adding is idempotent on the bytes.
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

  /** Failing here is surfaced immediately: the image looks attached, so a
   * missing file would only show up as a prompt pointing at nothing. */
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
  // `keydown` always fires, and the host clipboard is what was copied to.
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
    // Restage so the staged set matches what's shown — otherwise a removed
    // image would still be on disk and still land in the prompt.
    void stageImages(next);
  }

  /** Fold any `#N` typed in the goal into the attach list, so naming an issue
   * doesn't also need a Pick-issue step. Deterministic matching against the
   * already-loaded list — no `gh` round-trip at submit, no guessing at looser
   * references, and a no-op if nothing has loaded yet. */
  function reconcileGoalIssueRefs(): IssueItem[] {
    if (!issues) return selectedIssues;
    const already = new Set(selectedIssues.map((i) => `${i.repo}#${i.number}`));
    const additions = referencedIssueNumbers(goal)
      .map((n) => issues.find((i) => i.number === n))
      .filter((i): i is IssueItem => i !== undefined && !already.has(`${i.repo}#${i.number}`));
    return additions.length > 0 ? [...selectedIssues, ...additions] : selectedIssues;
  }

  function submit(worktree = true) {
    const issuesToAttach = reconcileGoalIssueRefs();
    if (worktree) {
      if (!branch) {
        showError("Give a goal (or type a branch name) first.");
        return;
      }
      if (branchProblem) {
        // Already shown inline under the branch field — no need to repeat it
        // in the bottom-of-form notice too.
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
    });
  }

  return (
    <div className="mx-3 my-1.5 flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5">
      <span className="text-[11px] font-medium text-muted-foreground">
        ✦ New task — {repo.name}
      </span>
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
            // The preventDefault above already swallowed the paste, so an
            // unwritable type (SVG) must say why rather than vanish.
            if (!pastedImages.some((it) => isPasteableImage(it.type))) {
              showError(`Can't attach ${pastedImages[0].type} — paste a PNG, JPEG, GIF, or WebP.`);
              return;
            }
            void pasteImages(e.clipboardData);
            return;
          }
          // Text: leave it to the textarea. `getData`, not `items` — that is
          // what WebKitGTK populates.
          if (e.clipboardData?.getData("text")) return;
          // Empty is what a WebKitGTK image paste looks like, so ask the OS
          // clipboard before concluding there's nothing to attach.
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
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") cancel();
          // No preventDefault: a text paste must still land natively, and an
          // image-only clipboard has no text to insert.
          if (e.key.toLowerCase() === "v" && (e.metaKey || e.ctrlKey)) {
            void pasteFromHostClipboard();
          }
        }}
        hint="paste or drop a screenshot to attach it"
        placeholder="what should this task get done?"
        rows={2}
      />
      {selectedIssues.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedIssues.map((issue) => (
            <span
              key={`${issue.repo}#${issue.number}`}
              title={issue.title}
              className="flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground"
            >
              #{issue.number}
              <button
                type="button"
                aria-label={`Detach issue #${issue.number}`}
                onClick={() => toggleIssue(issue)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-2.5" />
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
                  className="size-12 rounded border border-border object-cover"
                />
              </button>
              <button
                type="button"
                aria-label={`Remove ${img.name}`}
                onClick={() => removeImage(img.id)}
                className="absolute -top-1 -right-1 rounded-full border border-border bg-background p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
              >
                <X className="size-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <ImageLightbox images={images} openId={zoomedImageId} onOpenChange={setZoomedImageId} />
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          className="mr-auto h-6 gap-1 px-1.5 text-[10.5px]"
          title="Attach the image currently on your clipboard"
          onClick={() => {
            void pasteFromHostClipboard().then((found) => {
              if (!found) showError("No image on the clipboard — copy one first.");
            });
          }}
        >
          <ImagePlus className="size-3" />
          Attach image
        </Button>
        <Popover
          open={issuePickerOpen}
          onOpenChange={(o) => {
            setIssuePickerOpen(o);
            if (o) setIssuesWanted(true);
          }}
        >
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-6 gap-1 px-1.5 text-[10.5px]">
              <CircleDot className="size-3" />
              Pick issue
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="start">
            <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
              <span className="text-[10.5px] text-muted-foreground">
                GitHub issues — {repo.name}
              </span>
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
              <p className="p-3 text-[11px] text-muted-foreground">Loading issues…</p>
            ) : (
              <Command>
                <CommandInput placeholder="Search issues…" className="text-xs" />
                <CommandList className="max-h-64">
                  <CommandEmpty>No open issues.</CommandEmpty>
                  {issues.map((issue) => {
                    const selected = selectedIssues.some(
                      (i) => i.repo === issue.repo && i.number === issue.number,
                    );
                    return (
                      <CommandItem
                        key={issue.number}
                        value={`${issue.number} ${issue.title}`}
                        onSelect={() => toggleIssue(issue)}
                        className="flex items-start gap-2"
                      >
                        <Check className={cn("mt-0.5 size-3 shrink-0", !selected && "invisible")} />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="w-full truncate text-xs">{issue.title}</span>
                          <span className="text-[10.5px] text-muted-foreground">
                            #{issue.number}
                            {issue.labels.length > 0
                              ? ` · ${issue.labels.slice(0, 2).join(", ")}`
                              : ""}
                          </span>
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandList>
              </Command>
            )}
          </PopoverContent>
        </Popover>
        {preOverwrite && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[10.5px]"
            onClick={undoOverwrite}
          >
            <Undo2 className="size-3" />
            Undo
          </Button>
        )}
        {/* Prompt improvers: one button per preferred improver, the rest behind
            a chevron segment attached to the last one (a split button). Each
            rewrites the goal + branch fields in place via `claude -p` — Undo
            restores. */}
        {preferredImprovers.map((improver, i) => (
          <Button
            key={improver.id}
            variant="outline"
            size="sm"
            className={cn(
              "h-6 gap-1 px-1.5 text-[10.5px]",
              otherImprovers.length > 0 && i === preferredImprovers.length - 1 && "rounded-r-none",
            )}
            title={improver.prompt || undefined}
            disabled={improverDisabled}
            onClick={() => void runImprover(improver)}
          >
            <Sparkles className="size-3" />
            {suggesting === improver.id ? "Asking claude…" : improver.label}
          </Button>
        ))}
        {otherImprovers.length > 0 && (
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="-ml-[9px] h-6 rounded-l-none border-l-0 px-1 text-[10.5px]"
                title="More prompt improvers — mark one Preferred in Settings to give it its own button"
                disabled={improverDisabled}
              >
                <ChevronDown className="size-3" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1" align="end">
              {otherImprovers.map((improver) => (
                <button
                  key={improver.id}
                  type="button"
                  title={improver.prompt || undefined}
                  onClick={() => void runImprover(improver)}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                >
                  <Sparkles className="size-3 shrink-0" />
                  <span className="truncate">
                    {suggesting === improver.id ? "Asking claude…" : improver.label}
                  </span>
                </button>
              ))}
            </PopoverContent>
          </Popover>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[10.5px] text-muted-foreground">title</span>
        <Input
          value={title}
          onChange={(e) => setTitleEdit(e.target.value)}
          placeholder="auto-generated from your goal"
          className="min-w-0 text-xs"
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[10.5px] text-muted-foreground">branch</span>
        <Input
          value={branch}
          onChange={(e) => setBranchEdit(e.target.value)}
          placeholder="auto-generated from your goal"
          className={cn("min-w-0 font-mono text-xs", branchProblem && "border-red-500")}
        />
        {branchProblem && <p className="text-[10.5px] text-red-500">{branchProblem}</p>}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[10.5px] text-muted-foreground">base</span>
        <Popover open={baseOpen} onOpenChange={setBaseOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={baseOpen}
              className="min-w-0 justify-start truncate font-mono text-xs font-normal"
            >
              <span className="truncate">{baseLabel}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-(--radix-popover-trigger-width) p-0">
            <Command>
              <CommandInput placeholder="Search branches…" />
              <CommandList>
                <CommandEmpty>No branches found.</CommandEmpty>
                {sortedBranches.map((b) => (
                  <CommandItem
                    key={b.name}
                    value={b.label}
                    className="min-w-0 truncate font-mono text-xs"
                    onSelect={() => {
                      setBase(b.name);
                      setBaseOpen(false);
                    }}
                  >
                    <span className="truncate">{b.label}</span>
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      <div className="flex items-center gap-2">
        <Select value={model} onValueChange={(v) => setModel(v as ModelChoice)}>
          <SelectTrigger className="min-w-0 flex-1 font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODEL_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={effort} onValueChange={(v) => setEffort(v as EffortChoice)}>
          <SelectTrigger className="min-w-0 flex-1 font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EFFORT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <label
        htmlFor="new-task-launch-claude"
        className="flex cursor-pointer items-start gap-2"
        title="Off: create the worktree and its terminal session but leave it at a bare shell — nothing is typed into the PTY. The goal still becomes the board card and the session's label."
      >
        <Checkbox
          id="new-task-launch-claude"
          checked={launchClaude}
          onCheckedChange={(v) => setLaunchClaude(v === true)}
          className="mt-0.5"
        />
        <span className="text-[11px] leading-snug text-muted-foreground">
          Start Claude on the goal — off leaves the new task at a bare shell
        </span>
      </label>
      {notice && (
        <p
          className={cn(
            "text-[11px]",
            notice.kind === "error" ? "text-red-500" : "text-muted-foreground",
          )}
        >
          {notice.text}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button
          variant="outline"
          size="sm"
          title="Create the board task without a worktree — attach a task later by starting it again"
          disabled={!goal.trim() && selectedIssues.length === 0}
          onClick={() => submit(false)}
        >
          Task only
        </Button>
        <Button size="sm" disabled={!branch} onClick={() => submit(true)}>
          Start task
        </Button>
      </div>
    </div>
  );
}
