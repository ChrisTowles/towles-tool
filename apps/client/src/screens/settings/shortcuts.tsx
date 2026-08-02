import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { isEmptyQuery, matchesFilter } from "@/lib/settings-filter";
import { DEFAULT_SHORTCUT_COACH } from "@/lib/shortcut-coach";
import { SHORTCUTS, scopeTitle, shortcutKeys, type ShortcutScope } from "@/lib/shortcuts";
import type { UserSettings } from "@/lib/settings";
import { NoMatches, ToggleRow, type Update } from "./common";

// Blank for `global`: an unscoped binding needs no qualifier here.
function scopeLabel(scope: ShortcutScope): string {
  return scope === "global" ? "" : scopeTitle(scope);
}

// Off still tracks — the record feeds Telemetry → Keyboard either way. Lives
// outside `ShortcutsList`, filtered by the same predicate, so a query matching
// no binding can still surface the switch.
export function ShortcutCoachRow({
  settings,
  update,
  query,
}: {
  settings: UserSettings;
  update: Update;
  query: string;
}) {
  const shown =
    isEmptyQuery(query) ||
    matchesFilter(query, "Shortcut coach", ["nudge", "reminder", "coach", "keyboard", "habit"]);
  if (!shown) return null;
  return (
    <ToggleRow
      label="Shortcut coach"
      description="When you click something a keyboard shortcut also does, show a one-line reminder of the keys. Your keyboard-vs-mouse streak is tracked either way — see Telemetry → Keyboard."
      checked={settings.agentboard?.shortcutCoach ?? DEFAULT_SHORTCUT_COACH}
      onCheckedChange={(v) =>
        update((s) => ({ ...s, agentboard: { ...s.agentboard, shortcutCoach: v } }))
      }
    />
  );
}

/** Shortcuts list, filtered by the same predicate (description + when + scope). */
export function ShortcutsList({ query }: { query: string }) {
  const empty = isEmptyQuery(query);
  const rows = Object.values(SHORTCUTS).filter((s) =>
    empty
      ? true
      : matchesFilter(query, s.description, [
          s.when ?? "",
          scopeLabel(s.scope),
          ...shortcutKeys(s.id),
        ]),
  );
  if (rows.length === 0) return <NoMatches query={query} />;
  return (
    <div className="flex flex-col">
      {rows.map((s, i) => (
        <div
          key={s.id}
          className={`flex items-center justify-between py-2 ${
            i > 0 ? "border-t border-border" : ""
          }`}
        >
          <span className="text-sm text-muted-foreground">
            {s.description}
            {s.when && <span className="text-muted-foreground/70"> — {s.when}</span>}
            {s.scope !== "global" && (
              <span className="ml-2 text-xs text-muted-foreground/70">({scopeLabel(s.scope)})</span>
            )}
          </span>
          <KbdGroup>
            {shortcutKeys(s.id).map((cap) => (
              <Kbd key={cap}>{cap}</Kbd>
            ))}
          </KbdGroup>
        </div>
      ))}
    </div>
  );
}
