export type PaneRect = { left: number; top: number; width: number; height: number };

/** Per-mille, so persisted layouts stay integer and the Rust mirror keeps `Eq`. */
export const COL_TOTAL = 1000;

/** Narrowest a column can be dragged, per-mille (10%). */
const MIN_COL = 100;

const SNAP_POINTS = [200, 333, 400, 500, 600, 667, 800];

const SNAP_THRESHOLD = 25;

export function colCount(n: number): number {
  return n <= 3 ? n : 2;
}

/** `null` when the pane count changed since the drag — falls back to equal. */
function validCols(n: number, cols: number[] | undefined): number[] | null {
  const k = colCount(n);
  if (!cols || cols.length !== k) return null;
  if (cols.some((c) => !Number.isInteger(c) || c < MIN_COL)) return null;
  return cols.reduce((a, b) => a + b, 0) === COL_TOTAL ? cols : null;
}

/** Equal per-mille split, remainder on the last column (k=3 → 333/333/334). */
function equalCols(k: number): number[] {
  const base = Math.floor(COL_TOTAL / k);
  return Array.from({ length: k }, (_, i) => (i === k - 1 ? COL_TOTAL - base * (k - 1) : base));
}

/** Column widths in percent for an `n`-pane tiling under `cols`. */
function colWidths(n: number, cols: number[] | undefined): number[] {
  const valid = validCols(n, cols);
  // Multiply first: `(c * 100) / 1000` divides integers, so 200‰ → exactly 20.
  if (valid) return valid.map((c) => (c * 100) / COL_TOTAL);
  const k = colCount(n);
  return Array.from({ length: k }, () => 100 / k);
}

export function paneRects(n: number, cols?: number[]): PaneRect[] {
  if (n <= 0) return [];
  const widths = colWidths(n, cols);
  if (n <= 3) {
    let left = 0;
    return widths.map((width) => {
      const r = { left, top: 0, width, height: 100 };
      left += width;
      return r;
    });
  }
  const rows = Math.ceil(n / 2);
  const h = 100 / rows;
  return Array.from({ length: n }, (_, i) => {
    const lastRowSolo = n % 2 === 1 && i === n - 1;
    return {
      left: lastRowSolo || i % 2 === 0 ? 0 : widths[0],
      top: Math.floor(i / 2) * h,
      width: lastRowSolo ? 100 : widths[i % 2],
      height: h,
    };
  });
}

/** Magnetic snap: pull a divider position (per-mille) onto the nearest
 * third/fifth/half when within `SNAP_THRESHOLD`, else keep it (integered). */
export function snapCol(pos: number): number {
  for (const p of SNAP_POINTS) {
    if (Math.abs(pos - p) <= SNAP_THRESHOLD) return p;
  }
  return Math.round(pos);
}

/** Divider `i` sits between columns `i` and `i+1`; `pos` is from the left edge. */
export function dragCol(n: number, cols: number[] | undefined, i: number, pos: number): number[] {
  const widths = [...(validCols(n, cols) ?? equalCols(colCount(n)))];
  if (i < 0 || i >= widths.length - 1) return widths;
  const leftEdge = widths.slice(0, i).reduce((a, b) => a + b, 0);
  const lo = leftEdge + MIN_COL;
  const hi = leftEdge + widths[i] + widths[i + 1] - MIN_COL;
  const target = Math.min(hi, Math.max(lo, snapCol(pos)));
  const pair = widths[i] + widths[i + 1];
  widths[i] = target - leftEdge;
  widths[i + 1] = pair - widths[i];
  return widths;
}
