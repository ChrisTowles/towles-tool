import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { COL_TOTAL, dragCol, type AgWindow, type WindowsPayload } from "@/lib/agentboard";

export type ColumnDrag = {
  paneAreaRef: React.RefObject<HTMLDivElement | null>;
  /** Live column widths while a divider is being dragged (null at rest). */
  colDrag: { winId: string; cols: number[] } | null;
  startColDrag: (e: ReactPointerEvent<HTMLDivElement>, win: AgWindow, divider: number) => void;
  resetCols: (win: AgWindow) => void;
};

// Live widths ride local state so terminals reflow while dragging; the result
// commits to the window's `cols` on release. `dragCol` snaps to thirds/fifths.
export function useColumnDrag(
  updateWins: (folderDirs: string[], fn: (w: WindowsPayload) => WindowsPayload) => void,
): ColumnDrag {
  const paneAreaRef = useRef<HTMLDivElement>(null);
  const [colDrag, setColDrag] = useState<{ winId: string; cols: number[] } | null>(null);

  function startColDrag(e: ReactPointerEvent<HTMLDivElement>, win: AgWindow, divider: number) {
    e.preventDefault();
    const area = paneAreaRef.current;
    if (!area) return;
    const n = win.panes.length;
    const posOf = (clientX: number) => {
      const r = area.getBoundingClientRect();
      return ((clientX - r.left) / r.width) * COL_TOTAL;
    };
    let cols = dragCol(n, win.cols, divider, posOf(e.clientX));
    const move = (ev: PointerEvent) => {
      cols = dragCol(n, win.cols, divider, posOf(ev.clientX));
      setColDrag({ winId: win.id, cols });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setColDrag(null);
      updateWins([win.folderDir], (w) => ({
        ...w,
        windows: w.windows.map((x) => (x.id === win.id ? { ...x, cols } : x)),
      }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    setColDrag({ winId: win.id, cols });
  }

  /** Double-click a divider: back to equal columns. */
  function resetCols(win: AgWindow) {
    updateWins([win.folderDir], (w) => ({
      ...w,
      windows: w.windows.map((x) => (x.id === win.id ? { ...x, cols: undefined } : x)),
    }));
  }

  return { paneAreaRef, colDrag, startColDrag, resetCols };
}
