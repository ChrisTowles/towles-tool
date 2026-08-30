import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { NotInTauri } from "@/lib/errors";
import {
  defaultTelemetryRules,
  nextTelemetryRuleId,
  withDefaultTelemetryRules,
  type TelemetryRule,
} from "@/lib/settings";
import type { Filter, RuleKind } from "@/lib/telemetry";
import { uiAction } from "@/lib/ui-action";
import { ChipSegments } from "@/screens/telemetry/chips";
import { AddFilterChip, FilterChip } from "@/screens/telemetry/log-filter-bar";

/** The Rules list in Settings → Collectors: the same controlled-list shape as
 * the prompt improvers, but a rule is two filter lists and two numbers rather
 * than a prompt, so it has its own rows instead of `PromptTemplateList`. */

const KIND_OPTIONS: { value: RuleKind; label: string }[] = [
  { value: "share", label: "share" },
  { value: "count", label: "count" },
];

export function newTelemetryRule(rules: TelemetryRule[]): TelemetryRule {
  const label = `Rule ${rules.length + 1}`;
  return {
    id: nextTelemetryRuleId(rules, label),
    label,
    enabled: true,
    kind: "share",
    select: [],
    pass: [],
    threshold: 95,
    days: 1,
  };
}

export function TelemetryRulesEditor({
  rules,
  onChange,
  onCommit,
}: {
  rules: TelemetryRule[];
  onChange: (rules: TelemetryRule[], opts?: { defer?: boolean }) => void;
  onCommit?: () => void;
}) {
  const patch = (index: number, next: Partial<TelemetryRule>, opts?: { defer?: boolean }) =>
    onChange(
      rules.map((r, i) => (i === index ? { ...r, ...next } : r)),
      opts,
    );

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-sm font-medium">Rules</div>
        <div className="text-sm text-muted-foreground">
          Standing checks on the event log, scored on the Telemetry screen's Rules tab. A{" "}
          <strong>share</strong> rule is the percentage of records matching <em>select</em> that
          also match <em>pass</em>, and fails below its threshold; a <strong>count</strong> rule is
          how many records match <em>select</em>, and fails above it. Filters AND together. The
          threshold is judged over the newest <em>days</em> days.
        </div>
      </div>

      {rules.length === 0 ? (
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          No rules — the Rules tab has nothing to score.
        </div>
      ) : null}

      {rules.map((rule, index) => (
        <div key={rule.id} className="flex flex-col gap-2 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <Switch
              checked={rule.enabled}
              onCheckedChange={(v) => {
                patch(index, { enabled: v });
                uiAction("telemetry_rule.toggled", "settings", `${rule.id} ${v ? "on" : "off"}`);
              }}
              aria-label={`Score ${rule.label || rule.id}`}
            />
            <Input
              value={rule.label}
              onChange={(e) => patch(index, { label: e.target.value }, { defer: true })}
              onBlur={onCommit}
              placeholder="Label"
              aria-label="Label"
              className="h-8 max-w-56"
            />
            <span className="font-mono text-xs text-muted-foreground" title="Rule id">
              {rule.id}
            </span>
            <span className="ml-auto">
              <ChipSegments
                label="Kind:"
                value={rule.kind}
                options={KIND_OPTIONS}
                onChange={(kind) => patch(index, { kind })}
              />
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => {
                onChange(rules.filter((_, i) => i !== index));
                uiAction("telemetry_rule.removed", "settings", rule.id);
              }}
            >
              Remove
            </Button>
          </div>

          <FilterList
            label="Select"
            filters={rule.select}
            onChange={(select) => patch(index, { select })}
          />
          {rule.kind === "share" && (
            <FilterList
              label="Pass"
              filters={rule.pass}
              onChange={(pass) => patch(index, { pass })}
            />
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <label className="flex items-center gap-1.5">
              {rule.kind === "share" ? "Fails below" : "Fails above"}
              <Input
                type="number"
                min={0}
                max={rule.kind === "share" ? 100 : undefined}
                value={rule.threshold}
                onChange={(e) =>
                  patch(index, { threshold: clampThreshold(e.target.value, rule.kind) }, { defer: true })
                }
                onBlur={onCommit}
                aria-label="Threshold"
                className="h-7 w-20 font-mono text-xs"
              />
              {rule.kind === "share" ? "%" : "matches"}
            </label>
            <label className="flex items-center gap-1.5">
              over the newest
              <Input
                type="number"
                min={1}
                max={14}
                value={rule.days}
                onChange={(e) => patch(index, { days: clampDays(e.target.value) }, { defer: true })}
                onBlur={onCommit}
                aria-label="Days"
                className="h-7 w-16 font-mono text-xs"
              />
              {rule.days === 1 ? "day" : "days"}
            </label>
          </div>

          {rule.enabled && rule.select.length === 0 && (
            <div className="text-xs text-destructive">
              No select filter — this rule scores every record in the log.
            </div>
          )}
          {rule.enabled && rule.kind === "share" && rule.pass.length === 0 && (
            <div className="text-xs text-destructive">
              No pass filter — every selected record passes, so this rule is always 100%.
            </div>
          )}
        </div>
      ))}

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const rule = newTelemetryRule(rules);
            onChange([...rules, rule]);
            uiAction("telemetry_rule.added", "settings", rule.id);
          }}
        >
          Add rule
        </Button>
        <ResetRulesButton rules={rules} onChange={onChange} />
      </div>
    </div>
  );
}

function FilterList({
  label,
  filters,
  onChange,
}: {
  label: string;
  filters: Filter[];
  onChange: (filters: Filter[]) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-12 text-xs text-muted-foreground">{label}</span>
      {filters.map((f, i) => (
        <FilterChip
          key={`${f.field}-${f.op}-${f.value}-${i}`}
          filter={f}
          onRemove={() => onChange(filters.filter((_, j) => j !== i))}
        />
      ))}
      <AddFilterChip onAdd={(f) => onChange([...filters, f])} />
    </div>
  );
}

function clampThreshold(raw: string, kind: RuleKind): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return kind === "share" ? Math.min(100, n) : n;
}

function clampDays(raw: string): number {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? Math.min(14, Math.max(1, n)) : 1;
}

/** Confirmed first, as for prompt improvers: settings save on the spot. */
function ResetRulesButton({
  rules,
  onChange,
}: {
  rules: TelemetryRule[];
  onChange: (rules: TelemetryRule[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const reset = async () => {
    setBusy(true);
    const defaults = await defaultTelemetryRules();
    setBusy(false);
    if (defaults.isErr()) {
      if (!NotInTauri.is(defaults.error)) toast.error(defaults.error.message);
      return;
    }
    setOpen(false);
    onChange(withDefaultTelemetryRules(rules, defaults.value));
    uiAction("telemetry_rule.reset", "settings");
    toast.success("Rules reset to defaults");
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          Reset to defaults
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset the built-in rules?</AlertDialogTitle>
          <AlertDialogDescription className="text-pretty">
            The shipped rules go back to their original filters and thresholds, discarding your
            edits to them. Rules you added yourself are left alone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button disabled={busy} onClick={() => void reset()}>
            {busy ? "Resetting…" : "Reset"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
