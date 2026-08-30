import { useState, type FormEvent } from "react";
import { Bookmark, ChevronDown, Plus, Search, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
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
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 text-xs text-foreground hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

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
        <DropdownMenuTrigger className={chip}>
          {KIND_LABEL[kind]}
          <ChevronDown className="size-3 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup value={kind} onValueChange={(v) => onKind(v as KindFilter)}>
            {(Object.keys(KIND_LABEL) as KindFilter[]).map((k) => (
              <DropdownMenuRadioItem key={k} value={k}>
                {KIND_LABEL[k]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {filters.map((f, i) => (
        <FilterChip
          key={`${f.field}-${f.op}-${f.value}-${i}`}
          filter={f}
          onRemove={() => onRemoveFilter(i)}
        />
      ))}

      <DropdownMenu>
        <DropdownMenuTrigger className={chip}>
          Past {days} {days === 1 ? "day" : "days"}
          <ChevronDown className="size-3 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={String(days)}
            onValueChange={(v) => onDays(Number(v) as RangeDays)}
          >
            {RANGE_DAYS.map((d) => (
              <DropdownMenuRadioItem key={d} value={String(d)}>
                Past {d} {d === 1 ? "day" : "days"}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <AddFilterChip onAdd={props.onAddFilter} />

      <div className="relative ml-auto w-56">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search raw lines…"
          className="h-7 pl-8 text-xs"
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
      <PopoverAnchor asChild>
        <div className="inline-flex">
          <DropdownMenu>
            <DropdownMenuTrigger className={cn(chip, active && "font-medium")}>
              <Bookmark className="size-3 text-muted-foreground" />
              {active ? active.label : "View"}
              <ChevronDown className="size-3 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-56">
              {views.length === 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No saved views.</div>
              )}
              {views.map((v) => (
                <div key={v.id} className="flex items-center">
                  <DropdownMenuItem
                    className={cn("flex-1", v.id === activeViewId && "font-medium")}
                    onSelect={() => onSelectView(v)}
                  >
                    <span className="truncate">{v.label}</span>
                    <span className="ml-auto pl-3 font-mono text-[10.5px] text-muted-foreground">
                      {v.filters.length} · {v.days}d
                    </span>
                  </DropdownMenuItem>
                  <button
                    type="button"
                    aria-label={`Delete view ${v.label}`}
                    onClick={() => onDeleteView(v.id)}
                    className="mr-1 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setSaving(true)}>
                <Bookmark className="size-3.5" />
                Save current as view…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-64 p-2">
        <form onSubmit={submit} className="flex items-center gap-1.5">
          <Input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="View name"
            className="h-7 text-xs"
          />
          <Button type="submit" size="sm" className="h-7" disabled={!label.trim()}>
            Save
          </Button>
        </form>
      </PopoverContent>
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
        className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-3" />
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
      <PopoverTrigger className={cn(chip, "text-muted-foreground")}>
        <Plus className="size-3" />
        Add filter
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-2">
        <form onSubmit={submit} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <Input
              autoFocus
              list="tt-telemetry-filter-fields"
              value={field}
              onChange={(e) => setField(e.target.value)}
              placeholder="field"
              className="h-7 flex-1 font-mono text-xs"
            />
            <datalist id="tt-telemetry-filter-fields">
              {FILTER_FIELD_SUGGESTIONS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            <Select value={op} onValueChange={(v) => setOp(v as FilterOp)}>
              <SelectTrigger className="h-7 w-28 font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FILTER_OPS.map((o) => (
                  <SelectItem key={o} value={o} className="font-mono text-xs">
                    {OP_GLYPH[o]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="value"
              className="h-7 flex-1 font-mono text-xs"
            />
            <Button type="submit" size="sm" className="h-7" disabled={!field.trim()}>
              Add
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
