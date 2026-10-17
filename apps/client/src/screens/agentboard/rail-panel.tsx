import type { ReactNode, Ref, RefObject } from "react";
import { RollupChip } from "@/components/agentboard-rail";
import { NativePane } from "@/components/native-pane";
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
  jarvisPane,
  nativeVisible,
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
  jarvisPane: boolean;
  nativeVisible: boolean;
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

      {/* Jarvis: the lower quarter of the rail is a native Bevy
          surface, not DOM (see `components/native-pane.tsx`).
          `shrink-0` + `basis-1/4` rather than `h-1/4` so the
          ScrollArea above yields the space instead of both fighting
          over `flex-1`.

          Hidden whenever this screen is not the active tab: the
          surface sits *above* the webview, so it would otherwise
          cover whatever screen the user switched to — screens stay
          mounted here rather than unmounting.

          Off (the default) means *not rendered*, which is what
          hands the quarter back to the ScrollArea — and, on a
          checkout that never turns it on, what keeps a surface from
          being created at all. It does not reclaim one already
          shown: retiring parks the renderer rather than dropping it
          (`crates-tauri/tt-pane`). Toggle: the rail header's cube
          button. */}
      {jarvisPane && (
        <NativePane
          paneId="jarvis"
          visible={nativeVisible}
          className="shrink-0 basis-1/4 border-t"
        />
      )}
    </div>
  );
}
