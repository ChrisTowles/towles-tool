import { useId, useMemo, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { IconBtn } from "@/components/agentboard-bits";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  answeredCount,
  answerQuestions,
  askQuestions,
  OTHER_LABEL,
  promptKind,
  resolvePicks,
  setOther,
  suggestionLabel,
  togglePick,
  type AskQuestion,
  type PermissionDecision,
  type PermissionRequest,
  type QuestionPicks,
  type Verdict,
} from "@/lib/agent";
import { answerChat } from "@/lib/agent-sessions";
import { errorMessage, NotInTauri } from "@/lib/errors";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

/**
 * The card for a tool call the CLI is blocked on.
 *
 * Three shapes behind one control request — see `tt-agent`'s `control` module
 * for why they share a wire format:
 *
 * - a **question** (`AskUserQuestion`), where the answer is data written back
 *   into the tool's own input;
 * - a **plan** (`ExitPlanMode`), where approving runs it and refusing is how
 *   you send revision notes;
 * - a **gate** (everything else), a plain may-I.
 *
 * The classification itself is `promptKind` in `lib/agent.ts`, not here — it is
 * the branching worth testing, and a component is where it would stop being
 * tested.
 */
export function PermissionCard({
  agentId,
  request,
}: {
  agentId: string;
  request: PermissionRequest;
}) {
  const answer = answerer(agentId, request);
  // Parsed once and shared with the classifier: `request.input` is immutable
  // once folded in, but this card re-renders on every agent event and every
  // keystroke in the "Other" field.
  const questions = useMemo(() => askQuestions(request.input), [request.input]);

  switch (promptKind(request, questions)) {
    case "question":
      return <QuestionCard request={request} questions={questions} answer={answer} />;
    case "plan":
      return (
        <DecisionCard
          answer={answer}
          allowLabel="Approve plan"
          denyLabel="Request changes…"
          denyPlaceholder="What should change?"
          body={
            <div className="max-h-72 overflow-y-auto rounded-md bg-background/60 px-2 py-1.5">
              <Markdown
                content={typeof request.input.plan === "string" ? request.input.plan : ""}
                className="text-xs"
              />
            </div>
          }
        />
      );
    case "gate":
      return (
        <DecisionCard
          answer={answer}
          allowLabel="Allow once"
          denyLabel="Deny…"
          // The agent reads this, so it steers rather than merely refusing.
          denyPlaceholder="Why not? (optional — the agent reads this)"
          suggestions={request.suggestions}
          body={
            <p className="text-xs text-foreground">
              Run{" "}
              <span className="font-mono text-violet-500">
                {request.displayName ?? request.toolName}
              </span>
              {request.description && (
                <>
                  {" "}
                  on <span className="font-mono">{request.description}</span>
                </>
              )}
              ?
            </p>
          }
        />
      );
  }
}

/** How a card answers. Shared so no card can apply a decision without also
 * recording the verdict that names it. */
type Answer = (decision: PermissionDecision, verdict: Verdict) => void;

/** Not memoized: the cards below aren't memo components, so a stable identity
 * buys nothing, and answering is a one-shot terminal action rather than
 * something re-fired across renders. */
function answerer(agentId: string, request: PermissionRequest): Answer {
  return (decision, verdict) => {
    uiAction(`agent.permission.${verdict}`, "agentboard", request.toolName);
    void answerChat(agentId, request.requestId, request.toolName, decision, verdict).then((res) => {
      if (res.isErr() && !NotInTauri.is(res.error))
        toast.error(`Could not answer the agent: ${errorMessage(res.error)}`);
    });
  };
}

/**
 * Allow / always-allow / deny-with-a-reason, over an arbitrary body.
 *
 * The gate and the plan differ only in what they show and what the buttons are
 * called — the deny encoding in particular (trim, `undefined` rather than `""`)
 * is a rule that must not exist twice, since a fix to one copy would silently
 * miss the other.
 */
function DecisionCard({
  answer,
  body,
  allowLabel,
  denyLabel,
  denyPlaceholder,
  suggestions = [],
}: {
  answer: Answer;
  body: React.ReactNode;
  allowLabel: string;
  denyLabel: string;
  denyPlaceholder: string;
  suggestions?: unknown[];
}) {
  // `null` is "not refusing"; "" is "refusing, reason still empty" — which is
  // allowed, since the reason is optional.
  const [reason, setReason] = useState<string | null>(null);

  return (
    <div className="space-y-2 border-t border-amber-500/40 px-2.5 py-2">
      {body}
      {reason === null ? (
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => answer({ kind: "allow" }, "allow")}
          >
            {allowLabel}
          </Button>
          {suggestions.map((suggestion, i) => (
            <Button
              key={i}
              size="sm"
              variant="secondary"
              className="h-6 px-2 text-[11px]"
              onClick={() => answer({ kind: "allow", updatedPermissions: [suggestion] }, "allow")}
            >
              {suggestionLabel(suggestion)}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={() => setReason("")}
          >
            {denyLabel}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <Input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                answer({ kind: "deny", message: reason.trim() || undefined }, "deny");
              if (e.key === "Escape") setReason(null);
            }}
            placeholder={denyPlaceholder}
            className="h-6 text-[11px]"
          />
          <Button
            size="sm"
            variant="destructive"
            className="h-6 px-2 text-[11px]"
            onClick={() => answer({ kind: "deny", message: reason.trim() || undefined }, "deny")}
          >
            Send
          </Button>
          <IconBtn title="Cancel" onClick={() => setReason(null)}>
            <X className="size-3" />
          </IconBtn>
        </div>
      )}
    </div>
  );
}

/**
 * `AskUserQuestion`, rendered as the picker it is.
 *
 * Answering means **allowing the call with the answers written into its own
 * input** — the tool's result is its edited arguments, which is why this is a
 * permission card and not a message composer. Skipping is likewise an allow,
 * not a deny: the model asked, and "I'd rather not say" is a legitimate reply
 * that a refusal would misreport as an objection.
 *
 * All questions are shown at once rather than behind the VS Code extension's
 * tab strip. A chat pane is a column in a tiled grid, and two or three fit;
 * tabs would hide the second one behind a control at the exact moment the user
 * is deciding whether they have answered everything.
 */
function QuestionCard({
  request,
  questions,
  answer,
}: {
  request: PermissionRequest;
  questions: AskQuestion[];
  answer: Answer;
}) {
  const [picks, setPicks] = useState<Map<string, QuestionPicks>>(() => new Map());
  const answered = answeredCount(questions, picks);

  return (
    <div className="space-y-2.5 border-t border-amber-500/40 px-2.5 py-2">
      {questions.map((q) => (
        <QuestionBlock
          key={q.question}
          question={q}
          picks={picks.get(q.question)}
          onToggle={(label) => setPicks((cur) => togglePick(cur, q, label))}
          onOther={(text) => setPicks((cur) => setOther(cur, q, text))}
        />
      ))}
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          className="h-6 px-2 text-[11px]"
          disabled={answered === 0}
          onClick={() =>
            answer(
              { kind: "allow", updatedInput: answerQuestions(request.input, resolvePicks(picks)) },
              "answered",
            )
          }
        >
          Send {answered > 0 && questions.length > 1 ? `(${answered}/${questions.length})` : ""}
        </Button>
        {/* An allow with no answers — the CLI's own way of saying the user
            declined. Denying would tell the model you objected to being asked,
            which is a different message. */}
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={() => answer({ kind: "allow" }, "answered")}
        >
          Skip
        </Button>
      </div>
    </div>
  );
}

/**
 * One question's options, as checkboxes or radios.
 *
 * Radix primitives rather than `div role="checkbox"`: they bring the keyboard
 * and focus behaviour (Space/Enter, radio arrow-key roving, focus rings) that a
 * hand-rolled row has to restate and gets subtly wrong. The clickable-row
 * pattern is `<label htmlFor>`, per `resume-picker.tsx` — a `<button>` may not
 * contain interactive descendants, and the "Other" row has a text input, which
 * therefore stays a *sibling* of the label rather than a child of it (inside, a
 * click meant for the text field would toggle the option instead).
 */
function QuestionBlock({
  question,
  picks,
  onToggle,
  onOther,
}: {
  question: AskQuestion;
  picks: QuestionPicks | undefined;
  onToggle: (label: string) => void;
  onOther: (text: string) => void;
}) {
  const idBase = useId();
  const options = [...question.options, { label: OTHER_LABEL, description: undefined }];
  const selectedLabel = options.find((o) => picks?.labels.has(o.label))?.label ?? "";

  const rows = options.map((option, i) => {
    const selected = picks?.labels.has(option.label) ?? false;
    const id = `${idBase}-${i}`;
    return (
      <div key={option.label}>
        <label
          htmlFor={id}
          className={cn(
            "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 hover:bg-accent/50",
            selected && "bg-accent",
          )}
        >
          {question.multiSelect ? (
            <Checkbox
              id={id}
              checked={selected}
              onCheckedChange={() => onToggle(option.label)}
              className="mt-px size-3.5"
            />
          ) : (
            <RadioGroupItem
              id={id}
              value={option.label}
              // `onValueChange` can only ever select. Re-clicking the chosen
              // option used to clear it, and that stays true here.
              onClick={() => selected && onToggle(option.label)}
              className="mt-px size-3.5"
            />
          )}
          <span className="min-w-0">
            <span className="block text-xs text-foreground">{option.label}</span>
            {option.description && (
              <span className="block text-[10.5px] text-muted-foreground">
                {option.description}
              </span>
            )}
          </span>
        </label>
        {option.label === OTHER_LABEL && selected && (
          <Input
            autoFocus
            value={picks?.other ?? ""}
            onChange={(e) => onOther(e.target.value)}
            placeholder="Your answer"
            className="mt-1 ml-7 h-6 text-[11px]"
          />
        )}
      </div>
    );
  });

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-foreground">{question.question}</p>
      {question.multiSelect ? (
        <div className="space-y-0.5">{rows}</div>
      ) : (
        <RadioGroup value={selectedLabel} onValueChange={onToggle} className="grid-cols-1 gap-0.5">
          {rows}
        </RadioGroup>
      )}
    </div>
  );
}
