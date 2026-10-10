import { useRef, useState, type FormEvent } from "react";
import {
  BookmarkSimpleIcon,
  CaretDownIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Button, DropdownMenu, Input, Popover, Select } from "@cloudflare/kumo";
import { cn } from "@/lib/utils";
import { uiAction } from "@/lib/ui-action";
import type { SavedView } from "@/lib/settings";
import {
  FILTER_FIELD_SUGGESTIONS,
  FILTER_OPS,
  filterLabel,
  OP_GLYPH,
  RANGE_DAYS,
  type Filter,
  type FilterOp,
  type KindFilter,
  type RangeDays,
} from "@/lib/telemetry";

/** The Log tab's chip bar: saved view, kind, one chip per predicate, the day
 * range, Add filter, and free text. Every chip is a control, so each wears a
 * box; predicates print in mono because they are the query, not chrome. */

const KIND_LABEL: Record<KindFilter, string> = { all: "All", span: "Spans", event: "Events" };

const chip =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-kumo-hairline bg-kumo-base px-2 text-xs text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus";

export type LogFilterBarProps = {
  kind: KindFilter;
  onKind: (kind: KindFilter) => void;
  days: RangeDays;
  onDays: (days: RangeDays) => void;
  filters: Filter[];
  onAddFilter: (filter: Filter) => void;
  onRemoveFilter: (index: number) => void;
  query: string;
  onQuery: (query: string) => void;
  views: SavedView[];
  activeViewId: string | null;
  onSelectView: (view: SavedView) => void;
  onSaveView: (label: string) => void;
  onDeleteView: (id: string) => void;
};

export function LogFilterBar(props: LogFilterBarProps) {
  const { kind, onKind, days, onDays, filters, onRemoveFilter, query, onQuery } = props;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      <ViewChip {...props} />

      <DropdownMenu>
        <DropdownMenu.Trigger className={chip}>
          {KIND_LABEL[kind]}
          <CaretDownIcon className="size-3 text-kumo-subtle" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="start">
          <DropdownMenu.RadioGroup value={kind} onValueChange={(v) => onKind(v as KindFilter)}>
            {(Object.keys(KIND_LABEL) as KindFilter[]).map((k) => (
              <DropdownMenu.RadioItem key={k} value={k}>
                {KIND_LABEL[k]}
                <DropdownMenu.RadioItemIndicator />
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu>

      {filters.map((f, i) => (
        <FilterChip
          key={`${f.field}-${f.op}-${f.value}-${i}`}
          filter={f}
          onRemove={() => onRemoveFilter(i)}
        />
      ))}

      <DropdownMenu>
        <DropdownMenu.Trigger className={chip}>
          Past {days} {days === 1 ? "day" : "days"}
          <CaretDownIcon className="size-3 text-kumo-subtle" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="start">
          <DropdownMenu.RadioGroup
            value={String(days)}
            onValueChange={(v) => onDays(Number(v) as RangeDays)}
          >
            {RANGE_DAYS.map((d) => (
              <DropdownMenu.RadioItem key={d} value={String(d)}>
                Past {d} {d === 1 ? "day" : "days"}
                <DropdownMenu.RadioItemIndicator />
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu>

      <AddFilterChip onAdd={props.onAddFilter} />

      <div className="relative ml-auto w-56">
        <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-kumo-subtle" />
        <Input
          size="xs"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search raw lines…"
          aria-label="Search raw lines"
          className="pl-8"
        />
      </div>
    </div>
  );
}

function ViewChip({
  views,
  activeViewId,
  onSelectView,
  onSaveView,
  onDeleteView,
}: LogFilterBarProps) {
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState("");
  const anchorRef = useRef<HTMLDivElement>(null);
  const active = views.find((v) => v.id === activeViewId) ?? null;

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) return;
    onSaveView(trimmed);
    setLabel("");
    setSaving(false);
  }

  return (
    <Popover open={saving} onOpenChange={setSaving}>
      <div ref={anchorRef} className="inline-flex">
        <DropdownMenu>
          <DropdownMenu.Trigger className={cn(chip, active && "font-medium")}>
            <BookmarkSimpleIcon className="size-3 text-kumo-subtle" />
            {active ? active.label : "View"}
            <CaretDownIcon className="size-3 text-kumo-subtle" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="start" className="min-w-56">
            {views.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-kumo-subtle">No saved views.</div>
            )}
            {views.map((v) => (
              <div key={v.id} className="flex items-center">
                <DropdownMenu.Item
                  className={cn("flex-1", v.id === activeViewId && "font-medium")}
                  onClick={() => onSelectView(v)}
                >
                  <span className="truncate">{v.label}</span>
                  <span className="ml-auto pl-3 font-mono text-[10.5px] text-kumo-subtle">
                    {v.filters.length} · {v.days}d
                  </span>
                </DropdownMenu.Item>
                <button
                  type="button"
                  aria-label={`Delete view ${v.label}`}
                  onClick={() => onDeleteView(v.id)}
                  className="mr-1 rounded-sm p-1 text-kumo-subtle hover:bg-kumo-recessed hover:text-kumo-danger"
                >
                  <TrashIcon className="size-3" />
                </button>
              </div>
            ))}
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              onClick={() => {
                uiAction("telemetry.view_save_open", "telemetry");
                setSaving(true);
              }}
            >
              <BookmarkSimpleIcon className="size-3.5" />
              Save current as view…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
      <Popover.Content align="start" anchor={anchorRef} className="w-64 p-2">
        <form onSubmit={submit} className="flex items-center gap-1.5">
          <Input
            autoFocus
            size="xs"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="View name"
            aria-label="View name"
          />
          <Button type="submit" size="xs" variant="primary" disabled={!label.trim()}>
            Save
          </Button>
        </form>
      </Popover.Content>
    </Popover>
  );
}

/** One predicate as a removable chip; the Rules editor in Settings shares it. */
export function FilterChip({ filter, onRemove }: { filter: Filter; onRemove: () => void }) {
  return (
    <span className={cn(chip, "gap-1.5 pr-1 font-mono")}>
      {filterLabel(filter)}
      <button
        type="button"
        aria-label={`Remove filter ${filterLabel(filter)}`}
        onClick={onRemove}
        className="rounded-sm p-0.5 text-kumo-subtle hover:bg-kumo-recessed hover:text-kumo-default"
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}

export function AddFilterChip({ onAdd }: { onAdd: (filter: Filter) => void }) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState("");
  const [op, setOp] = useState<FilterOp>("eq");
  const [value, setValue] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const f = field.trim();
    if (!f) return;
    onAdd({ field: f, op, value: value.trim() });
    setField("");
    setValue("");
    setOp("eq");
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={cn(chip, "text-kumo-subtle")}>
        <PlusIcon className="size-3" />
        Add filter
      </Popover.Trigger>
      <Popover.Content align="start" className="w-80 p-2">
        <form onSubmit={submit} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <Input
              autoFocus
              size="xs"
              list="tt-telemetry-filter-fields"
              value={field}
              onChange={(e) => setField(e.target.value)}
              placeholder="field"
              aria-label="Filter field"
              className="flex-1 font-mono"
            />
            <datalist id="tt-telemetry-filter-fields">
              {FILTER_FIELD_SUGGESTIONS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            <Select
              size="xs"
              label="Operator"
              value={op}
              onValueChange={(v) => setOp(v as FilterOp)}
              className="w-28 font-mono"
            >
              {FILTER_OPS.map((o) => (
                <Select.Option key={o} value={o}>
                  {OP_GLYPH[o]}
                </Select.Option>
              ))}
            </Select>
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              size="xs"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="value"
              aria-label="Filter value"
              className="flex-1 font-mono"
            />
            <Button type="submit" size="xs" variant="primary" disabled={!field.trim()}>
              Add
            </Button>
          </div>
        </form>
      </Popover.Content>
    </Popover>
  );
}
