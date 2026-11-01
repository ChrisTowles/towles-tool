import type { ReactNode, Ref, RefObject } from "react";
import { RollupChip } from "@/components/agentboard-rail";
import { ScrollEdgeShades } from "@/components/scroll-edge-shades";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { RepoData } from "@/lib/agentboard/types";
import { RailViewToggle } from "./rail-view-toggle";
import type { RailView } from "@/lib/screens";
import { SimBar } from "./sim-bar";

/** The expanded rail: the Tree/Queue switch, rollup tally, then whichever body
 * the screen hands it. Only the contents swap, so the panel keeps its identity
 * and the panes beside it never remount. */
export function RailPanel({
  view,
  onViewChange,
  repos,
  compactPct,
  now,
  header,
  body,
  scrollRef,
  edges,
  focusRef,
}: {
  view: RailView;
  onViewChange: (view: RailView) => void;
  repos: RepoData[];
  compactPct: number;
  now: number;
  /** Tree rail only; the queue has no header. */
  header: ReactNode;
  body: ReactNode;
  scrollRef: Ref<HTMLDivElement>;
  edges: { above: boolean; below: boolean };
  focusRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="flex h-full flex-col border-r">
      <RailViewToggle view={view} onChange={onViewChange} />
      <SimBar />
      <RollupChip repos={repos} compactPct={compactPct} now={now} />
      {/* min-h-0 is load-bearing: without it this flex child grows past the
          rail's height and rows below the fold become unreachable. */}
      {header}
      {/* The shades say there is more above/below the fold. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ScrollArea className="min-h-0 flex-1" viewportRef={scrollRef}>
          <div ref={focusRef}>{body}</div>
        </ScrollArea>
        <ScrollEdgeShades above={edges.above} below={edges.below} />
      </div>
    </div>
  );
}
