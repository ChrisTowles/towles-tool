import { Fragment, useEffect, useState } from "react";
import { Check, ChevronsUpDown, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isEmptyQuery, matchesFilter } from "@/lib/settings-filter";
import { slackListUsers, type SlackUser } from "@/lib/slack";
import type { UserSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";

/** Set `defer` for anything the user types into, not for one-click choices. */
export type Update = (fn: (prev: UserSettings) => UserSettings, opts?: { defer?: boolean }) => void;

/** Wired to the blur of every deferring input, so tabbing out of a field saves. */
export type Flush = () => Promise<void>;

// Keywords carry synonyms and the section name, so a row labeled "Enabled" is
// still discoverable by typing "slack".
export type FilterRow = {
  label: string;
  keywords?: string[];
  node: React.ReactNode;
};

/** A named (or anonymous) group of rows. Its heading hides when no row matches. */
export type FilterSection = {
  heading?: string;
  keywords?: string[];
  rows: FilterRow[];
};

/** `extra` renders between the description and `children`. */
export function SettingRow({
  label,
  description,
  extra,
  children,
}: {
  label: string;
  description: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-sm text-muted-foreground">{description}</div>
      </div>
      <div className="flex items-center gap-3">
        {extra}
        {children}
      </div>
    </div>
  );
}

export function TabHeading({
  title,
  note,
  action,
}: {
  title: string;
  note: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{note}</p>
      </div>
      {action}
    </div>
  );
}

/** Stacked label + description above a full-width control (text/number rows). */
export function FieldRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-sm font-medium">{label}</div>
      <div className="text-sm text-muted-foreground">{description}</div>
      {children}
    </div>
  );
}

/** Toggle row: label + description on the left, a Switch on the right. */
export function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
  extra,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  extra?: React.ReactNode;
}) {
  return (
    <SettingRow label={label} description={description} extra={extra}>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </SettingRow>
  );
}

/** Small number field with a trailing unit (e.g. cadence in minutes). */
export function CadenceRow({
  label,
  description,
  value,
  unit,
  onValue,
  onCommit,
}: {
  label: string;
  description: string;
  value: number;
  unit: string;
  onValue: (n: number) => void;
  /** Commit the debounced write now (blur) rather than waiting out the delay. */
  onCommit?: () => void;
}) {
  return (
    <SettingRow label={label} description={description}>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={1}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n >= 1) onValue(Math.floor(n));
          }}
          onBlur={onCommit}
          className="w-20"
        />
        <span className="text-sm text-muted-foreground">{unit}</span>
      </div>
    </SettingRow>
  );
}

/** Default context-usage % at which a session is flagged for compaction
 * (mirrors `tt_config::DEFAULT_COMPACT_RECOMMEND_PERCENT`). */
export const DEFAULT_COMPACT_RECOMMEND_PERCENT = 30;

/** Parse a text hour into a 0–23 int (ignoring junk by clamping). */
export function clampHour(raw: string): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.min(23, Math.max(0, n));
}

/** Password-style input with a show/hide toggle, for secret tokens. */
export function RevealInput({
  value,
  onChange,
  placeholder,
  onCommit,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Commit the debounced write now (blur) rather than waiting out the delay. */
  onCommit?: () => void;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        placeholder={placeholder}
        className="pr-9 font-mono text-xs"
        spellCheck={false}
        autoComplete="off"
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? "Hide token" : "Show token"}
        className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
      >
        {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

/** Weekday chips (0 = Monday … 6 = Sunday, matching the Rust quiet-hours mask). */
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function WeekdayChips({
  value,
  onChange,
}: {
  value: number[];
  onChange: (days: number[]) => void;
}) {
  const toggle = (day: number) => {
    const next = value.includes(day) ? value.filter((d) => d !== day) : [...value, day];
    next.sort((a, b) => a - b);
    onChange(next);
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {WEEKDAY_LABELS.map((label, day) => {
        const on = value.includes(day);
        return (
          <button
            key={day}
            type="button"
            onClick={() => toggle(day)}
            aria-pressed={on}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              on
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-muted",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// Picks the watched user from the workspace directory so a name is chosen
// instead of a pasted member id. Degrades to a plain member-id input.
export function SlackUserPicker({
  userId,
  userName,
  onPick,
  onIdChange,
  onIdCommit,
}: {
  userId: string;
  userName: string;
  onPick: (user: SlackUser) => void;
  onIdChange: (id: string) => void;
  onIdCommit?: () => void;
}) {
  const [users, setUsers] = useState<SlackUser[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void slackListUsers().then((listed) => {
      if (!alive) return;
      listed.match({ ok: setUsers, err: () => setFailed(true) });
    });
    return () => {
      alive = false;
    };
  }, []);

  // No usable directory (browser dev, bad token, load error, empty workspace).
  if (failed || (users !== null && users.length === 0)) {
    return (
      <Input
        value={userId}
        onChange={(e) => onIdChange(e.target.value)}
        onBlur={onIdCommit}
        className="font-mono text-xs"
        placeholder="U0123ABCD"
        spellCheck={false}
      />
    );
  }
  if (users === null) {
    return <div className="text-xs text-muted-foreground">Loading members…</div>;
  }

  const selected = users.find((u) => u.id === userId);
  const label = selected?.name || userName || userId || "Select a person…";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search people…" />
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            <CommandGroup>
              {users.map((u) => (
                <CommandItem
                  key={u.id}
                  value={`${u.name} ${u.id}`}
                  onSelect={() => {
                    onPick(u);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn("mr-2 size-4", u.id === userId ? "opacity-100" : "opacity-0")}
                  />
                  <span className="truncate">{u.name}</span>
                  <span className="ml-2 font-mono text-[10px] text-muted-foreground">{u.id}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Shown in wired tabs while settings load, or when there's no Tauri host. */
export function SettingsLoading() {
  return <div className="text-sm text-muted-foreground">Loading settings…</div>;
}

function rowKeywords(section: FilterSection, row: FilterRow): string[] {
  return [
    ...(row.keywords ?? []),
    ...(section.keywords ?? []),
    ...(section.heading ? [section.heading] : []),
  ];
}

/** Empty state shown when the current filter hides every row in a tab. */
export function NoMatches({ query }: { query: string }) {
  return (
    <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
      No settings match “{query.trim()}”.
    </div>
  );
}

// A section with no surviving rows drops its heading too, and nothing left
// renders the empty state. `prelude` is a note the filter never applies to.
export function FilteredContent({
  query,
  sections,
  prelude,
}: {
  query: string;
  sections: FilterSection[];
  prelude?: React.ReactNode;
}) {
  const empty = isEmptyQuery(query);
  const visible = sections
    .map((section) => ({
      section,
      rows: empty
        ? section.rows
        : section.rows.filter((row) => matchesFilter(query, row.label, rowKeywords(section, row))),
    }))
    .filter((entry) => entry.rows.length > 0);

  if (visible.length === 0) return <NoMatches query={query} />;

  return (
    <>
      {empty && prelude}
      {visible.map(({ section, rows }, i) => (
        <section key={section.heading ?? i} className="flex flex-col gap-4">
          {section.heading && <h3 className="text-sm font-semibold">{section.heading}</h3>}
          {rows.map((row) => (
            <Fragment key={row.label}>{row.node}</Fragment>
          ))}
        </section>
      ))}
    </>
  );
}
