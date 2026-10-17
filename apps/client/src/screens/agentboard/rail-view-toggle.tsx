import { Tabs } from "@cloudflare/kumo";
import { Kbd } from "@/components/ui/kbd";
import { ListNumbersIcon, TreeStructureIcon } from "@phosphor-icons/react";
import type { RailView } from "@/lib/screens";
import { mouseAction } from "@/lib/shortcut-coach";
import { shortcutHint } from "@/lib/shortcuts";

const VIEWS: { value: RailView; label: string; icon: typeof ListNumbersIcon }[] = [
  { value: "tree", label: "Tree", icon: TreeStructureIcon },
  { value: "queue", label: "Queue", icon: ListNumbersIcon },
];

/** Which rail Agent Board shows: every checkout by place, or tasks in the
 * order to work them. Only the rail swaps; the panes beside it stay put. */
export function RailViewToggle({
  view,
  onChange,
}: {
  view: RailView;
  onChange: (view: RailView) => void;
}) {
  return (
    <div
      className="flex items-center gap-2 border-b border-kumo-hairline bg-kumo-base px-3 py-1.5"
      title={`Switch rail (${shortcutHint("ab-rail-view")})`}
    >
      <Tabs
        variant="segmented"
        size="sm"
        value={view}
        onValueChange={(v) => {
          mouseAction("ab-rail-view", "agentboard");
          onChange(v === "tree" ? "tree" : "queue");
        }}
        tabs={VIEWS.map((v) => ({
          value: v.value,
          label: (
            <span className="flex items-center gap-1.5">
              <v.icon className="size-3.5" />
              {v.label}
            </span>
          ),
        }))}
      />
      <Kbd aria-hidden className="ml-auto opacity-60">
        {shortcutHint("ab-rail-view")}
      </Kbd>
    </div>
  );
}
