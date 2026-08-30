import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** The filter-chip bar shared by the Dashboard and Builds tabs. Violet marks a
 * chip that is off its default — the app's "focus" accent, never status. */

const CHIP =
  "inline-flex h-6 items-center gap-1 rounded-full border border-border bg-card px-2.5 font-mono text-[11px] text-muted-foreground";

const ACTIVE = "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300";

export function Chip({ children }: { children: React.ReactNode }) {
  return <span className={CHIP}>{children}</span>;
}

export function ChipMenu({
  label,
  active,
  items,
  ariaLabel,
}: {
  label: string;
  active: boolean;
  items: { key: string; label: string; onSelect: () => void }[];
  ariaLabel?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={ariaLabel}
        className={cn(
          CHIP,
          "hover:bg-accent/50 data-[state=open]:border-violet-500/40 data-[state=open]:bg-violet-500/10 data-[state=open]:text-violet-700 dark:data-[state=open]:text-violet-300",
          active && ACTIVE,
        )}
      >
        {label}
        <ChevronDown className="size-3 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        {items.map((it) => (
          <DropdownMenuItem key={it.key} onSelect={it.onSelect} className="font-mono text-xs">
            {it.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** An on/off chip. */
export function ChipToggle({
  label,
  pressed,
  onPressedChange,
}: {
  label: string;
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
      className={cn(CHIP, "hover:bg-accent/50", pressed && ACTIVE)}
    >
      {label}
    </button>
  );
}

/** A two-way chip: `label` then the options, the chosen one lit. */
export function ChipSegments<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <span className={cn(CHIP, "gap-0 px-0")}>
      <span className="pl-2.5 pr-1.5">{label}</span>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-full px-2 last:rounded-r-full hover:bg-accent/50",
            o.value === value && "bg-violet-500/10 text-violet-700 dark:text-violet-300",
          )}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}
