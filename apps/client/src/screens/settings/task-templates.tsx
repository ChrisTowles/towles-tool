import { Button, Input, InputArea, Select } from "@cloudflare/kumo";
import type { PromptImprover, TaskTemplate } from "@/lib/settings";
import { nextTaskTemplateId } from "@/lib/task-templates";
import { uiAction } from "@/lib/ui-action";

/** A Select needs a non-empty value; settings store "none" as "". */
const NO_IMPROVER = "none";

/** The new-task form's presets. `repo` and `improver` are free text and a pick, not
 * validated against what's tracked now: a template outlives a repo being untracked. */
export function TaskTemplatesEditor({
  templates,
  improvers,
  onChange,
  onCommit,
}: {
  templates: TaskTemplate[];
  improvers: PromptImprover[];
  onChange: (templates: TaskTemplate[], opts?: { defer?: boolean }) => void;
  onCommit: () => void;
}) {
  const typed = { defer: true };
  const patch = (index: number, next: Partial<TaskTemplate>, opts?: { defer?: boolean }) =>
    onChange(
      templates.map((t, i) => (i === index ? { ...t, ...next } : t)),
      opts,
    );
  const improverItems = [
    { value: NO_IMPROVER, label: "No improver" },
    ...improvers.map((i) => ({ value: i.id, label: i.label || i.id })),
  ];

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-sm font-medium">Task templates</div>
        <div className="text-sm text-kumo-subtle">
          Presets in the new-task form&apos;s <strong>Template</strong> picker, and{" "}
          <code>tt task new --template &lt;id&gt;</code>. Picking one puts its goal ahead of what
          you typed (Undo restores it) and leads with its improver; its setup command runs after the
          repo&apos;s own. Leave <strong>Repo</strong> empty to offer it everywhere.
        </div>
      </div>

      {templates.length === 0 ? (
        <div className="rounded-md border border-dashed border-kumo-hairline p-3 text-sm text-kumo-subtle">
          No task templates — the new-task form shows no picker.
        </div>
      ) : null}

      {templates.map((t, index) => (
        <div key={t.id} className="flex flex-col gap-2 rounded-md border border-kumo-hairline p-3">
          <div className="flex items-center gap-2">
            <Input
              value={t.label}
              onChange={(e) => patch(index, { label: e.target.value }, typed)}
              onBlur={onCommit}
              placeholder="Label"
              aria-label="Template label"
              size="sm"
              className="max-w-56"
            />
            <span className="font-mono text-xs text-kumo-subtle" title="--template id">
              {t.id}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto text-kumo-subtle"
              onClick={() => {
                onChange(templates.filter((_, i) => i !== index));
                uiAction("task_template.removed", "settings", t.id);
              }}
            >
              Remove
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={t.repo}
              onChange={(e) => patch(index, { repo: e.target.value }, typed)}
              onBlur={onCommit}
              placeholder="Repo name or dir — empty for every repo"
              aria-label={`Repo for ${t.label || t.id}`}
              size="sm"
              className="flex-1"
            />
            <Select
              aria-label={`Improver for ${t.label || t.id}`}
              size="sm"
              className="w-44"
              value={t.improver || NO_IMPROVER}
              items={improverItems}
              onValueChange={(v) =>
                patch(index, { improver: v === NO_IMPROVER ? "" : (v as string) })
              }
            />
          </div>
          <InputArea
            value={t.goal}
            onChange={(e) => patch(index, { goal: e.target.value }, typed)}
            onBlur={onCommit}
            placeholder="Goal to start from, e.g. Reproduce it with a failing test first, then fix."
            rows={3}
            aria-label={`Goal for ${t.label || t.id}`}
          />
          <Input
            value={t.setup}
            onChange={(e) => patch(index, { setup: e.target.value }, typed)}
            onBlur={onCommit}
            placeholder="Extra setup command (optional), e.g. bun run db:seed"
            spellCheck={false}
            aria-label={`Setup command for ${t.label || t.id}`}
            size="sm"
            className="font-mono text-xs"
          />
        </div>
      ))}

      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const label = `Template ${templates.length + 1}`;
            const id = nextTaskTemplateId(templates, label);
            onChange([...templates, { id, label, repo: "", goal: "", improver: "", setup: "" }]);
            uiAction("task_template.added", "settings", id);
          }}
        >
          Add task template
        </Button>
      </div>
    </div>
  );
}
