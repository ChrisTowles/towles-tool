import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import {
  BOLD,
  FAINT,
  INVERSE,
  INVISIBLE,
  ITALIC,
  OVERLINE,
  STRIKETHROUGH,
  UNDERLINE,
  graphemeClusters,
  isWideRun,
  rgb,
  isCopyChord,
  isPasteChord,
  keyEventWire,
  scrollbackKey,
  stepMatch,
  MODIFIER_KEYS,
  viewportMatches,
  TERM_CLEAR_COMMAND,
  type Cursor,
  type Frame,
  type KeyEventWire,
  type Run,
  type SearchMatch,
  type TermExit,
} from "@/lib/term-protocol";
import { linkAt, linkLabel, type TermLink } from "@/lib/term-links";
import { resolveTermTheme } from "@/lib/term-theme";
import {
  selectionGestureKey,
  selectionKindForDetail,
  shouldCopyOnSelect,
} from "@/lib/terminal-selection";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  clampTerminalFontSize,
  useCopyOnSelect,
  useTerminalFontSize,
} from "@/lib/terminal-prefs";
import {
  IS_MAC,
  matchesEditableOverride,
  matchesShortcut,
  useShortcutsWorkInTerminal,
} from "@/lib/shortcuts";
import { openExternalUrl } from "@/lib/open-url";
import { invoke } from "@/lib/tauri";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { IconBtn } from "@/components/agentboard-bits";

/** Alpha washes, so they read on light and dark terminal themes. */
const MATCH_FILL = "rgba(250, 204, 21, 0.3)";
const CURRENT_MATCH_FILL = "rgba(249, 115, 22, 0.5)";
const CURRENT_MATCH_STROKE = "rgba(249, 115, 22, 0.9)";

const FONT_FAMILY =
  "'FiraCode Nerd Font Mono', ui-monospace, 'JetBrains Mono', 'Fira Code', monospace";
const LINE_HEIGHT = 1.25;

/** Selection autoscroll: rows scale with how far past the edge the pointer
 * is, so a small overshoot creeps and a big one moves. */
const AUTOSCROLL_INTERVAL_MS = 50;
const AUTOSCROLL_MAX_ROWS = 5;

/** Rust owns the PTY and the state, keyed by `termId`; this paints
 * `terminal://frame` diffs. Many mount at once, so each filters events by id. */
export function TerminalView({
  termId,
  cwd,
  onExit,
  onTitle,
  onOpenPath,
  focusRequest,
}: {
  termId: string;
  cwd?: string;
  onExit: (exit: TermExit) => void;
  /** OSC 0/2. Claude Code emits `✳ <title>`, which the rail uses as its label. */
  onTitle?: (termId: string, title: string) => void;
  /** Absent, links open via `term_open_path` in the preferred editor. */
  onOpenPath?: (path: string, line: number | null) => void;
  /** Bump to focus this pane's hidden input, for the paths that jump into a
   * terminal without a click on its canvas. Absent/unchanged does nothing. */
  focusRequest?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const onOpenPathRef = useRef(onOpenPath);
  onOpenPathRef.current = onOpenPath;
  // `termId` goes along so a relative path resolves against where this shell
  // has since `cd`'d, not its spawn `cwd`.
  const openPathInEditor = (link: Extract<TermLink, { kind: "path" }>) =>
    void invoke("term_open_path", { path: link.path, cwd, line: link.line, termId });
  const openPathInEditorRef = useRef(openPathInEditor);
  openPathInEditorRef.current = openPathInEditor;

  // The canvas paints from `searchRef`; `bridgeRef` hands the overlay its IPC.
  const searchRef = useRef<{ matches: SearchMatch[]; current: number }>({
    matches: [],
    current: -1,
  });
  const bridgeRef = useRef<{
    search: (query: string) => Promise<SearchMatch[]>;
    scrollTo: (row: number) => void;
    repaint: () => void;
    focusTerm: () => void;
    copy: () => void;
    paste: () => void;
    selectAll: () => void;
    hasSelection: () => boolean;
    clearScrollback: () => void;
    /** Open a path link in the preferred editor (resolved against the cwd). */
    openPath: (link: Extract<TermLink, { kind: "path" }>) => void;
    /** The link under a canvas pixel (right-click point), or null. */
    linkAtPoint: (offsetX: number, offsetY: number) => TermLink | null;
    /** Re-measure the cell grid at a new terminal font size (px), in place. */
    setFontSize: (px: number) => void;
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(-1);
  const [copyEnabled, setCopyEnabled] = useState(false);
  const [menuLink, setMenuLink] = useState<TermLink | null>(null);
  // Held back because the shell lacks bracketed paste (every line would
  // execute); the dialog re-sends it with force.
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const confirmPaste = () => {
    const text = pendingPaste;
    setPendingPaste(null);
    if (!text) return;
    void invoke("term_paste", { termId, text, force: true });
  };
  const copyOnSelectRef = useCopyOnSelect();
  // Whether board-wide shortcuts yield instead of going to the shell.
  const shortcutsWorkInTerminalRef = useShortcutsWorkInTerminal();
  // Ref'd so the key handler reads it live: re-running that effect would
  // restart the shell.
  const [fontSize, setTerminalFontSize] = useTerminalFontSize();
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const setTerminalFontSizeRef = useRef(setTerminalFontSize);
  setTerminalFontSizeRef.current = setTerminalFontSize;

  const runSearch = useCallback(async (q: string) => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    const matches = q ? await bridge.search(q) : [];
    const current = matches.length - 1; // start at the most recent match
    searchRef.current = { matches, current };
    setMatchCount(matches.length);
    setCurrentMatch(current);
    if (current >= 0) bridge.scrollTo(matches[current].row);
    bridge.repaint();
  }, []);

  const step = useCallback((dir: 1 | -1) => {
    const sr = searchRef.current;
    const next = stepMatch(sr.matches.length, sr.current, dir);
    if (next < 0) return;
    sr.current = next;
    setCurrentMatch(next);
    bridgeRef.current?.scrollTo(sr.matches[next].row);
    bridgeRef.current?.repaint();
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
    setMatchCount(0);
    setCurrentMatch(-1);
    searchRef.current = { matches: [], current: -1 };
    bridgeRef.current?.repaint();
    bridgeRef.current?.focusTerm();
  }, []);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);
  useEffect(() => {
    if (focusRequest !== undefined) inputRef.current?.focus({ preventScroll: true });
  }, [focusRequest]);
  // Debounced — each keystroke otherwise round-trips the engine.
  useEffect(() => {
    if (!searchOpen) return;
    const t = setTimeout(() => void runSearch(query), 150);
    return () => clearTimeout(t);
  }, [searchOpen, query, runSearch]);

  // Re-measure without re-running (and so restarting) the shell-owning effect.
  useEffect(() => {
    bridgeRef.current?.setFontSize(fontSize);
  }, [fontSize]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const input = inputRef.current;
    if (!host || !canvas || !input) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Seeded from the host's colors; frame.colors are authoritative after.
    const cs = getComputedStyle(host);
    const theme = { bg: cs.backgroundColor || "#1e1e2e", fg: cs.color || "#cdd6f4" };

    // Mutable so a zoom can re-measure in place without tearing down the shell.
    let fontPx = fontSizeRef.current;
    let cellW = 0;
    let cellH = 0;
    let baseline = 0;
    const measure = () => {
      ctx.font = `${fontPx}px ${FONT_FAMILY}`;
      cellW = ctx.measureText("M").width;
      cellH = Math.ceil(fontPx * LINE_HEIGHT);
      baseline = Math.round((cellH - fontPx) / 2 + fontPx * 0.8);
    };
    measure();

    // Grid mirror, so a repaint the engine didn't prompt comes from local state.
    const grid = {
      cols: Math.max(2, Math.floor(host.clientWidth / cellW)),
      rows: Math.max(1, Math.floor(host.clientHeight / cellH)),
      lines: [] as { runs: Run[]; wrapped?: boolean; sel?: [number, number] }[],
      cursor: null as Cursor | null,
      modes: { altScreen: false, mouseTracking: false },
      scrolledBack: false,
      /** URL under the mouse — underlined and Ctrl/Cmd-clickable. */
      hoveredLink: null as TermLink | null,
      /** Absolute row of the viewport top — maps search matches to viewport
       * rows, and converts pointer cells to the absolute rows `term_select`
       * speaks. */
      viewportTop: 0,
      /** Scrollback depth, which is also the largest `viewportTop` can get
       * (they are equal at the live bottom) — the clamp an optimistic scroll
       * predicts against. */
      scrollbackRows: 0,
      /** A selection is installed, wherever it currently sits. */
      selection: false,
    };

    const setFont = (flags: number) => {
      const bold = flags & BOLD ? "bold " : "";
      const italic = flags & ITALIC ? "italic " : "";
      ctx.font = `${italic}${bold}${fontPx}px ${FONT_FAMILY}`;
    };

    const paintRow = (y: number) => {
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, y * cellH, canvas.clientWidth, cellH);
      for (const run of grid.lines[y]?.runs ?? []) {
        const flags = run.flags ?? 0;
        let fg = run.fg !== undefined ? rgb(run.fg) : theme.fg;
        let bg = run.bg !== undefined ? rgb(run.bg) : theme.bg;
        if (flags & INVERSE) [fg, bg] = [bg, fg];
        const px = run.x * cellW;
        const w = run.width * cellW;
        if (bg !== theme.bg || flags & INVERSE) {
          ctx.fillStyle = bg;
          ctx.fillRect(px, y * cellH, w, cellH);
        }
        if (flags & INVISIBLE) continue;
        ctx.fillStyle = fg;
        ctx.globalAlpha = flags & FAINT ? 0.6 : 1;
        setFont(flags);
        if (isWideRun(run)) {
          // One fillText per grapheme cluster: combining marks and emoji
          // selectors compose instead of shifting the grid.
          let cx = px;
          for (const cluster of graphemeClusters(run.text)) {
            ctx.fillText(cluster, cx, y * cellH + baseline);
            cx += (cluster.codePointAt(0) ?? 0) > 0xff ? 2 * cellW : cellW;
          }
        } else {
          ctx.fillText(run.text, px, y * cellH + baseline);
        }
        ctx.globalAlpha = 1;
        if (flags & (UNDERLINE | STRIKETHROUGH | OVERLINE)) {
          ctx.lineWidth = 1;
          const line = (ly: number) => {
            ctx.beginPath();
            ctx.moveTo(px, ly);
            ctx.lineTo(px + w, ly);
            ctx.stroke();
          };
          if (flags & UNDERLINE) {
            // SGR 58 falls back to the glyph color; the 4:x variants are what
            // nvim/helix diagnostics emit.
            ctx.strokeStyle = run.ulc !== undefined ? rgb(run.ulc) : fg;
            const uy = y * cellH + baseline + 2;
            switch (run.ul) {
              case 2: // double
                line(uy - 1);
                line(uy + 1);
                break;
              case 3: {
                ctx.beginPath();
                for (let i = 0; i <= w; i += 2) {
                  const zy = uy + (i % 4 === 0 ? -1 : 1);
                  if (i === 0) ctx.moveTo(px, zy);
                  else ctx.lineTo(px + i, zy);
                }
                ctx.stroke();
                break;
              }
              case 4: // dotted
                ctx.setLineDash([1, 2]);
                line(uy);
                ctx.setLineDash([]);
                break;
              case 5: // dashed
                ctx.setLineDash([4, 2]);
                line(uy);
                ctx.setLineDash([]);
                break;
              default:
                line(uy);
            }
          }
          ctx.strokeStyle = fg;
          if (flags & STRIKETHROUGH) line(y * cellH + cellH / 2);
          if (flags & OVERLINE) line(y * cellH + 1);
        }
      }
      for (const seg of grid.hoveredLink?.segments ?? []) {
        if (seg.y !== y) continue;
        ctx.strokeStyle = theme.fg;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(seg.start * cellW, y * cellH + baseline + 2);
        ctx.lineTo((seg.end + 1) * cellW, y * cellH + baseline + 2);
        ctx.stroke();
      }
      const sel = grid.lines[y]?.sel;
      if (sel) {
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = theme.fg;
        ctx.fillRect(sel[0] * cellW, y * cellH, (sel[1] - sel[0] + 1) * cellW, cellH);
        ctx.globalAlpha = 1;
      }
      const sr = searchRef.current;
      if (sr.matches.length) {
        for (const m of viewportMatches(sr.matches, grid.viewportTop, grid.rows)) {
          if (m.y !== y) continue;
          const isCurrent = m.index === sr.current;
          ctx.fillStyle = isCurrent ? CURRENT_MATCH_FILL : MATCH_FILL;
          ctx.fillRect(m.col * cellW, y * cellH, m.width * cellW, cellH);
          if (isCurrent) {
            ctx.strokeStyle = CURRENT_MATCH_STROKE;
            ctx.lineWidth = 1;
            ctx.strokeRect(m.col * cellW + 0.5, y * cellH + 0.5, m.width * cellW - 1, cellH - 1);
          }
        }
      }
    };

    const paintCursor = () => {
      const c = grid.cursor;
      if (!c || !c.visible || grid.scrolledBack) return;
      const px = c.x * cellW;
      const py = c.y * cellH;
      // A program may set its own cursor color (OSC 12); theme otherwise.
      const cursorColor = c.color !== undefined ? rgb(c.color) : theme.fg;
      ctx.fillStyle = cursorColor;
      switch (c.shape) {
        case "bar":
          ctx.fillRect(px, py, 2, cellH);
          break;
        case "underline":
          ctx.fillRect(px, py + cellH - 2, cellW, 2);
          break;
        case "hollow":
          ctx.strokeStyle = cursorColor;
          ctx.strokeRect(px + 0.5, py + 0.5, cellW - 1, cellH - 1);
          break;
        default: {
          ctx.fillRect(px, py, cellW, cellH);
          // Echo is off for a secret: a lock glyph instead of the absent char.
          const ch = c.password ? "🔒" : charAt(grid.lines[c.y]?.runs ?? [], c.x);
          if (ch) {
            ctx.fillStyle = theme.bg;
            setFont(0);
            ctx.fillText(ch, px, py + baseline);
          }
        }
      }
    };

    const setHoveredLink = (link: TermLink | null) => {
      const prev = grid.hoveredLink;
      if (!prev && !link) return;
      if (
        prev &&
        link &&
        linkLabel(prev) === linkLabel(link) &&
        prev.segments[0].y === link.segments[0].y &&
        prev.segments[0].start === link.segments[0].start
      ) {
        return;
      }
      grid.hoveredLink = link;
      canvas.style.cursor = link ? "pointer" : "default";
      const openHint =
        link?.kind === "path"
          ? onOpenPathRef.current
            ? "open in files"
            : "open in editor"
          : "open";
      canvas.title = link ? `${linkLabel(link)}\nCtrl+Click (⌘+Click) to ${openHint}` : "";
      const rows = new Set([...(prev?.segments ?? []), ...(link?.segments ?? [])].map((s) => s.y));
      for (const y of rows) paintRow(y);
      paintCursor();
    };

    const paintAll = () => {
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      for (let y = 0; y < grid.lines.length; y++) paintRow(y);
      paintCursor();
    };

    const applyFrame = (frame: Frame) => {
      const prevCursorY = grid.cursor?.y;
      const resized = frame.cols !== grid.cols || frame.rows !== grid.rows;
      if (frame.full) {
        grid.cols = frame.cols;
        grid.rows = frame.rows;
        grid.lines = Array.from({ length: frame.rows }, () => ({ runs: [] }));
      } else if (resized) {
        // Resize race: adjust the row count but KEEP the rows — wiping blanks
        // rows the engine thinks are clean and never resends (#47).
        grid.cols = frame.cols;
        grid.rows = frame.rows;
        while (grid.lines.length < frame.rows) grid.lines.push({ runs: [] });
        grid.lines.length = frame.rows;
      }
      for (const row of frame.changed)
        grid.lines[row.y] = { runs: row.runs, wrapped: row.wrapped, sel: row.sel };
      // Changed text under a hovered link: drop it rather than underline stale
      // cells; the next mousemove re-detects.
      if (
        grid.hoveredLink &&
        (frame.full ||
          resized ||
          grid.hoveredLink.segments.some((s) => frame.changed.some((r) => r.y === s.y)))
      ) {
        grid.hoveredLink = null;
        canvas.style.cursor = "default";
        canvas.title = "";
      }
      grid.cursor = frame.cursor;
      grid.modes = frame.modes;
      grid.viewportTop = frame.viewportTop;
      grid.scrollbackRows = frame.scrollbackRows;
      grid.selection = frame.selection;
      // Tracking the engine's colors keeps OSC 10/11 answers honest.
      theme.fg = rgb(frame.colors.fg);
      theme.bg = rgb(frame.colors.bg);
      // The frame is the truth here, not the wheel handler's optimistic flag.
      grid.scrolledBack = frame.viewportTop < frame.scrollbackRows;
      if (frame.title !== undefined) onTitleRef.current?.(termId, frame.title);

      if (frame.full || resized) {
        paintAll();
        return;
      }
      for (const row of frame.changed) paintRow(row.y);
      if (prevCursorY !== undefined && !frame.changed.some((r) => r.y === prevCursorY)) {
        paintRow(prevCursorY);
      }
      if (!frame.changed.some((r) => r.y === frame.cursor.y) && frame.cursor.y !== prevCursorY) {
        paintRow(frame.cursor.y);
      }
      paintCursor();
    };

    const fitCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(host.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(host.clientHeight * dpr));
      canvas.style.width = `${host.clientWidth}px`;
      canvas.style.height = `${host.clientHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.textBaseline = "alphabetic";
    };
    fitCanvas();

    // StrictMode double-mounts in dev: `disposed` stops the stale mount from
    // starting a second shell, `started` stops it killing one it didn't spawn.
    let disposed = false;
    let started = false;
    const unlisteners: (() => void)[] = [];
    const disposers: (() => void)[] = [];

    void (async () => {
      // Outside Tauri there is no PTY bridge; note it instead of throwing.
      if (!("__TAURI_INTERNALS__" in window)) {
        ctx.fillStyle = theme.fg;
        setFont(0);
        ctx.fillText("terminals require the desktop app (browser dev mode)", 8, baseline + 8);
        return;
      }

      const { listen } = await import("@tauri-apps/api/event");

      const write = (data: string) => void invoke("term_write", { termId, data });
      const scroll = (delta: number | null) => void invoke("term_scroll", { termId, delta });
      // Written in Rust: navigator.clipboard is unreliable under WebKitGTK.
      const copySelection = () => void invoke("term_copy", { termId });

      const onFrame = await listen<{ termId: string; frame: Frame }>("terminal://frame", (e) => {
        if (e.payload.termId === termId) applyFrame(e.payload.frame);
      });
      if (disposed) return onFrame();
      unlisteners.push(onFrame);

      const onExitEvent = await listen<TermExit>("terminal://exit", (e) => {
        if (e.payload.termId === termId) onExitRef.current(e.payload);
      });
      if (disposed) return onExitEvent();
      unlisteners.push(onExitEvent);

      const spawn = await invoke("term_start", {
        termId,
        cols: grid.cols,
        rows: grid.rows,
        cwd,
        theme: resolveTermTheme(host),
      });
      // Say so on the canvas — there is no other surface for this pane's failure.
      if (spawn.isErr()) {
        ctx.fillStyle = theme.fg;
        setFont(0);
        ctx.fillText(`could not start shell: ${spawn.error.message}`, 8, baseline + 8);
        return;
      }
      started = true;
      if (disposed) return void invoke("term_kill", { termId });

      // Re-push on a theme change; the engine answers with a full frame.
      const themeObserver = new MutationObserver(() => {
        void invoke("term_theme", { termId, theme: resolveTermTheme(host) });
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "data-color-theme"],
      });
      unlisteners.push(() => themeObserver.disconnect());

      const backToLive = () => {
        if (grid.scrolledBack) {
          grid.scrolledBack = false;
          scroll(null);
        }
      };
      // The engine encodes against live terminal state (kitty, DECCKM, keypad
      // mode) — the view never builds escapes.
      const sendKey = (event: KeyEventWire) => void invoke("term_key", { termId, event });
      // The engine strips paste-bracket escapes and answers needsConfirm for a
      // multi-line paste on a bare shell.
      const paste = (text: string) => {
        backToLive();
        void invoke<{ needsConfirm: boolean }>("term_paste", { termId, text }).then((reply) => {
          if (reply.unwrapOr(null)?.needsConfirm) setPendingPaste(text);
        });
      };
      // Read in Rust: readText() rejects with NotAllowedError under WebKitGTK.
      const pasteClipboard = () => {
        backToLive();
        void invoke<{ needsConfirm: boolean; text: string }>("term_paste_clipboard", {
          termId,
        }).then((reply) => {
          const r = reply.unwrapOr(null);
          if (r?.needsConfirm) setPendingPaste(r.text);
        });
      };

      const onKeyDown = (e: KeyboardEvent) => {
        if (e.isComposing) return;
        // Board-wide actions bubble instead of becoming a control byte —
        // encodeKey ignores shift on Ctrl combos, so Ctrl+Shift+N sends Ctrl+N.
        if (shortcutsWorkInTerminalRef.current && matchesEditableOverride(e)) return;
        // The search chord is ours (plain Ctrl+F stays with the shell).
        if (matchesShortcut("term-search", e)) {
          e.preventDefault();
          setSearchOpen(true);
          return;
        }
        if (isCopyChord(e)) {
          e.preventDefault();
          copySelection();
          return;
        }
        if (isPasteChord(e)) {
          e.preventDefault();
          pasteClipboard();
          return;
        }
        // Font zoom is ours, not the shell's. Numpad emits `+`/`-`, hence both.
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
          if (e.key === "=" || e.key === "+") {
            e.preventDefault();
            setTerminalFontSizeRef.current(clampTerminalFontSize(fontSizeRef.current + 1));
            return;
          }
          if (e.key === "-" || e.key === "_") {
            e.preventDefault();
            setTerminalFontSizeRef.current(clampTerminalFontSize(fontSizeRef.current - 1));
            return;
          }
          if (e.key === "0") {
            e.preventDefault();
            setTerminalFontSizeRef.current(DEFAULT_TERMINAL_FONT_SIZE);
            return;
          }
        }
        // These drive the scrollback, except on the alternate screen where a
        // TUI owns them and the unshifted key is forwarded instead.
        const scrollback = scrollbackKey(e);
        if (scrollback) {
          e.preventDefault();
          if (grid.modes.altScreen) {
            sendKey({
              code: e.code,
              key: e.key,
              action: "press",
              shift: false,
              alt: false,
              ctrl: false,
              meta: false,
              capsLock: false,
              numLock: false,
            });
            return;
          }
          const page = Math.max(1, grid.rows - 1);
          switch (scrollback) {
            case "page-up":
              grid.scrolledBack = true;
              scroll(-page);
              break;
            case "page-down":
              scroll(page); // engine clamps at the live bottom
              break;
            case "top":
              if (grid.viewportTop > 0) {
                grid.scrolledBack = true;
                scroll(-grid.viewportTop);
              }
              break;
            case "bottom":
              backToLive();
              break;
          }
          return;
        }
        const wire = keyEventWire(e);
        if (wire) {
          e.preventDefault();
          // A bare modifier press must not yank a scrolled-back viewport down.
          if (!MODIFIER_KEYS.has(e.key)) backToLive();
          sendKey(wire);
        }
      };
      // Only kitty REPORT_EVENTS cares; the engine no-ops these otherwise.
      const onKeyUp = (e: KeyboardEvent) => {
        if (e.isComposing) return;
        const wire = keyEventWire(e, "release");
        if (wire) sendKey(wire);
      };
      const onPaste = (e: ClipboardEvent) => {
        e.preventDefault();
        // An image has no getData("text"), so the paste would vanish. \x16 tells
        // a TUI to read it off the clipboard itself.
        const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
        if (items.some((it) => it.type.startsWith("image/"))) {
          backToLive();
          write("\x16");
          return;
        }
        const text = e.clipboardData?.getData("text");
        if (text) paste(text);
      };
      // IME: composed text arrives on compositionend, not keydown.
      const onComposed = (e: CompositionEvent) => {
        if (e.data) write(e.data);
        input.value = "";
      };
      // The engine owns the whole wheel policy; the view reports the gesture.
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const lines =
          e.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? Math.round(e.deltaY)
            : Math.round(e.deltaY / cellH) || Math.sign(e.deltaY);
        if (lines === 0) return;
        const cell = cellOf(e);
        // Shift means "this gesture is mine, not the program's" — the same
        // override the click path applies, and the only way into scrollback
        // while a program holds mouse tracking open.
        void invoke("term_wheel", { termId, x: cell.x, y: cell.y, lines, shift: e.shiftKey });
      };
      const focusInput = () => input.focus({ preventScroll: true });

      bridgeRef.current = {
        search: (q) =>
          invoke<SearchMatch[]>("term_search", { termId, query: q }).then((r) => r.unwrapOr([])),
        scrollTo: (row) => void invoke("term_scroll_to", { termId, row }),
        repaint: paintAll,
        focusTerm: focusInput,
        copy: copySelection,
        paste: pasteClipboard,
        selectAll: () => void select("all"),
        // The engine's answer, not `grid.lines`: a selection scrolled out of
        // the viewport highlights no row while still being copyable.
        hasSelection: () => grid.selection,
        clearScrollback: () => void invoke(TERM_CLEAR_COMMAND, { termId }),
        // `onOpenPath` when the parent wired one, else the external editor.
        openPath: (link) => {
          const handler = onOpenPathRef.current;
          if (handler) handler(link.path, link.line);
          else openPathInEditorRef.current(link);
        },
        linkAtPoint: (offsetX, offsetY) => {
          const x = Math.max(0, Math.min(grid.cols - 1, Math.floor(offsetX / cellW)));
          const y = Math.max(0, Math.min(grid.rows - 1, Math.floor(offsetY / cellH)));
          return linkAt(grid.lines, grid.cols, x, y);
        },
        // Re-measure in place — no shell restart — and resize the PTY if
        // cols/rows changed for the same pixel box.
        setFontSize: (px) => {
          if (px === fontPx) return;
          fontPx = px;
          measure();
          fitCanvas();
          const cols = Math.max(2, Math.floor(host.clientWidth / cellW));
          const rows = Math.max(1, Math.floor(host.clientHeight / cellH));
          paintAll();
          if (cols !== grid.cols || rows !== grid.rows) {
            grid.cols = cols;
            grid.rows = rows;
          }
          void invoke("term_resize", {
            termId,
            cols,
            rows,
            cellWidth: Math.round(cellW),
            cellHeight: cellH,
          });
        },
      };
      // Reconcile if the persisted size loaded after this effect measured.
      if (fontPx !== fontSizeRef.current) bridgeRef.current.setFontSize(fontSizeRef.current);

      // The pending select IPC, so copy-on-select can await it before
      // `term_copy` reads — those calls are otherwise unordered.
      let lastSelect: Promise<unknown> = Promise.resolve();
      // Endpoints are ABSOLUTE cells (`row` from the oldest scrollback row).
      // A drag outlives the viewport it began in, so a viewport row re-sent
      // on the next mousemove names whatever text has since slid into that
      // slot. See `Select` in tt-vt.
      const select = (
        kind: "drag" | "word" | "line" | "all" | "clear",
        a?: { x: number; row: number },
        b?: { x: number; row: number },
      ) => {
        lastSelect = invoke("term_select", {
          termId,
          kind,
          ax: a?.x,
          ay: a?.row,
          bx: b?.x,
          by: b?.row,
        });
        return lastSelect;
      };
      /** The absolute cell a viewport cell currently sits on. */
      const absolute = (cell: { x: number; y: number }) => ({
        x: cell.x,
        row: grid.viewportTop + cell.y,
      });
      // What the last copy-on-select took, so repeating the gesture doesn't
      // re-take the clipboard. Reset on clear and blur: both are new intent.
      let lastCopiedGesture: string | null = null;
      const maybeCopyOnSelect = (kind: "drag" | "word" | "line", gesture: string | null) => {
        if (!shouldCopyOnSelect(copyOnSelectRef.current, kind, gesture, lastCopiedGesture)) return;
        lastCopiedGesture = gesture;
        void lastSelect.then(copySelection);
      };
      // Measured off the canvas rect rather than `offsetX/offsetY`, so the
      // same function serves events on the canvas, on the padded host (the
      // wheel), and on the window (a drag that left the pane).
      const pointOf = (e: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        return { x: (e.clientX - rect.left) / cellW, y: (e.clientY - rect.top) / cellH };
      };
      const cellOf = (e: MouseEvent) => {
        const p = pointOf(e);
        return {
          x: Math.max(0, Math.min(grid.cols - 1, Math.floor(p.x))),
          y: Math.max(0, Math.min(grid.rows - 1, Math.floor(p.y))),
        };
      };
      // The drag's fixed end, absolute so it keeps naming the pressed text.
      let anchor: { x: number; row: number } | null = null;
      let dragged = false;
      // The pointer, in canvas cell units and deliberately *unclamped*: a `y`
      // outside `[0, rows)` is what says "keep scrolling".
      let dragPoint: { x: number; y: number } | null = null;
      let autoscrollTimer: ReturnType<typeof setInterval> | null = null;
      const stopAutoscroll = () => {
        if (autoscrollTimer === null) return;
        clearInterval(autoscrollTimer);
        autoscrollTimer = null;
      };
      // A tracking program gets wheel, motion, middle and plain left clicks —
      // never left drags or word/line gestures, which stay local selection. So
      // a left press waits for mouseup to know which it was.
      const mouseToProgram = (e: MouseEvent) =>
        grid.modes.mouseTracking && !grid.scrolledBack && !e.shiftKey;
      // A held-back left press owed to the program if no drag develops, plus
      // the *viewport* cell to replay it at — not the anchor's space.
      let clickToProgram = false;
      let pressCell: { x: number; y: number } | null = null;
      const MOUSE_BUTTONS = ["left", "middle", "right"] as const;
      let mouseGestureToProgram = false;
      let lastMotionCell: { x: number; y: number } | null = null;
      const sendMouse = (
        e: MouseEvent,
        action: "press" | "release" | "motion",
        cell: { x: number; y: number },
      ) =>
        void invoke("term_mouse", {
          termId,
          event: {
            action,
            button: action === "motion" ? undefined : MOUSE_BUTTONS[e.button],
            x: cell.x,
            y: cell.y,
            shift: e.shiftKey,
            alt: e.altKey,
            ctrl: e.ctrlKey,
            anyButton: e.buttons !== 0,
          },
        });
      /** How far past an edge the pointer sits, in rows; 0 while inside. */
      const edgeOverrun = () => {
        if (!dragPoint) return 0;
        if (dragPoint.y < 0) return Math.max(-AUTOSCROLL_MAX_ROWS, Math.floor(dragPoint.y));
        if (dragPoint.y >= grid.rows) {
          return Math.min(AUTOSCROLL_MAX_ROWS, Math.floor(dragPoint.y) - grid.rows + 1);
        }
        return 0;
      };
      /** Re-point the drag's head at the pointer, against the live viewport. */
      const extendDrag = () => {
        if (!anchor || !dragPoint) return;
        const head = absolute({
          x: Math.max(0, Math.min(grid.cols - 1, Math.floor(dragPoint.x))),
          y: Math.max(0, Math.min(grid.rows - 1, Math.floor(dragPoint.y))),
        });
        if (!dragged && head.x === anchor.x && head.row === anchor.row) return;
        dragged = true;
        setHoveredLink(null);
        void select("drag", anchor, head);
      };
      // Dragging past an edge pages the viewport and keeps selecting — the
      // only way to take a selection taller than one screen. On a timer, since
      // a pointer held outside the pane stops producing events; against a
      // *predicted* `viewportTop`, since the frame reporting the scroll lands
      // after this tick must already say where the head goes.
      const autoscrollTick = () => {
        const delta = edgeOverrun();
        if (!anchor || delta === 0) {
          stopAutoscroll();
          return;
        }
        const next = Math.max(0, Math.min(grid.scrollbackRows, grid.viewportTop + delta));
        // Nothing left to reveal at this end — the head already sits on it.
        if (next === grid.viewportTop) return;
        scroll(delta);
        grid.viewportTop = next;
        dragged = true;
        void select("drag", anchor, {
          x: Math.max(0, Math.min(grid.cols - 1, Math.floor(dragPoint?.x ?? 0))),
          row: delta < 0 ? grid.viewportTop : grid.viewportTop + grid.rows - 1,
        });
      };
      const syncAutoscroll = () => {
        if (anchor && edgeOverrun() !== 0) {
          autoscrollTimer ??= setInterval(autoscrollTick, AUTOSCROLL_INTERVAL_MS);
        } else {
          stopAutoscroll();
        }
      };
      const onMouseDown = (e: MouseEvent) => {
        focusInput();
        if (e.button !== 0) {
          // Middle-click goes to a tracking program; right-click is the menu's.
          if (e.button === 1 && mouseToProgram(e)) {
            e.preventDefault();
            mouseGestureToProgram = true;
            sendMouse(e, "press", cellOf(e));
          }
          return;
        }
        e.preventDefault(); // keep focus on the hidden input
        const cell = cellOf(e);
        // Ctrl/Cmd+click opens a link; plain click keeps select/focus.
        if (e.ctrlKey || e.metaKey) {
          const link = linkAt(grid.lines, grid.cols, cell.x, cell.y);
          if (link) {
            if (link.kind === "url") void openExternalUrl(link.url);
            else bridgeRef.current?.openPath(link);
            return;
          }
        }
        const kind = selectionKindForDetail(e.detail);
        const at = absolute(cell);
        if (kind === "word" || kind === "line") {
          void select(kind, at);
          // Keyed on the absolute scrollback row, so a scroll makes it new.
          maybeCopyOnSelect(kind, selectionGestureKey(kind, at.x, at.row));
        } else {
          anchor = at;
          pressCell = cell;
          dragPoint = pointOf(e);
          dragged = false;
          clickToProgram = mouseToProgram(e);
        }
      };
      const onMouseMove = (e: MouseEvent) => {
        const cell = cellOf(e);
        // Motion during a forwarded gesture, or hover under mode 1003. Deduped
        // to cell granularity.
        if (mouseGestureToProgram || (!anchor && mouseToProgram(e))) {
          if (lastMotionCell?.x !== cell.x || lastMotionCell?.y !== cell.y) {
            lastMotionCell = cell;
            sendMouse(e, "motion", cell);
          }
          if (mouseGestureToProgram) return;
        }
        // A drag is tracked on the window instead (see `onWindowMouseMove`),
        // so it survives the pointer leaving the canvas.
        if (!anchor) setHoveredLink(linkAt(grid.lines, grid.cols, cell.x, cell.y));
      };
      // Every pooled pane hears this; `anchor` is what says the drag is ours.
      const onWindowMouseMove = (e: MouseEvent) => {
        if (!anchor) return;
        // A mouseup swallowed elsewhere (another app grabbed the pointer)
        // would otherwise leave the gesture — and its autoscroll — running.
        if (e.buttons === 0) {
          onMouseUp(e);
          return;
        }
        dragPoint = pointOf(e);
        extendDrag();
        syncAutoscroll();
      };
      const onMouseUp = (e: MouseEvent) => {
        if (mouseGestureToProgram) {
          mouseGestureToProgram = false;
          sendMouse(e, "release", lastMotionCell ?? cellOf(e));
          return;
        }
        stopAutoscroll();
        if (anchor && !dragged) {
          void select("clear");
          lastCopiedGesture = null;
          // Deliver the click the program was owed (held back at mousedown).
          if (clickToProgram && pressCell && mouseToProgram(e)) {
            sendMouse(e, "press", pressCell);
            sendMouse(e, "release", pressCell);
          }
        } else if (anchor && dragged) {
          // This fires for every window mouseup in every pooled pane, and a
          // stale `dragged` re-copied this pane's old selection on each one.
          maybeCopyOnSelect("drag", null);
        }
        anchor = null;
        pressCell = null;
        dragPoint = null;
        dragged = false;
        clickToProgram = false;
      };
      const onMouseLeave = () => setHoveredLink(null);
      // OSC 52 writes are gated to the focused terminal in the backend.
      const setFocus = (focused: boolean) => void invoke("term_focus", { termId, focused });
      const onFocus = () => setFocus(true);
      const onBlur = () => {
        setFocus(false);
        lastCopiedGesture = null;
      };

      input.addEventListener("keydown", onKeyDown);
      input.addEventListener("keyup", onKeyUp);
      input.addEventListener("paste", onPaste);
      input.addEventListener("compositionend", onComposed);
      input.addEventListener("focus", onFocus);
      input.addEventListener("blur", onBlur);
      host.addEventListener("wheel", onWheel, { passive: false });
      canvas.addEventListener("mousedown", onMouseDown);
      canvas.addEventListener("mousemove", onMouseMove);
      canvas.addEventListener("mouseleave", onMouseLeave);
      window.addEventListener("mousemove", onWindowMouseMove);
      window.addEventListener("mouseup", onMouseUp);
      disposers.push(() => {
        stopAutoscroll();
        input.removeEventListener("keydown", onKeyDown);
        input.removeEventListener("keyup", onKeyUp);
        input.removeEventListener("paste", onPaste);
        input.removeEventListener("compositionend", onComposed);
        input.removeEventListener("focus", onFocus);
        input.removeEventListener("blur", onBlur);
        host.removeEventListener("wheel", onWheel);
        canvas.removeEventListener("mousedown", onMouseDown);
        canvas.removeEventListener("mousemove", onMouseMove);
        canvas.removeEventListener("mouseleave", onMouseLeave);
        window.removeEventListener("mousemove", onWindowMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        setFocus(false);
      });
      focusInput();
    })();

    // Hidden panes collapse to 0×0 and grow back on window switches.
    let wasHidden = false;
    const observer = new ResizeObserver(() => {
      if (host.clientWidth === 0 || host.clientHeight === 0) {
        // Never resize a hidden pane's PTY to a degenerate 2×1 grid — it
        // reflows the shell offscreen and panes come back stale (#47).
        wasHidden = true;
        void invoke("term_visibility", { termId, visible: false });
        return;
      }
      const cols = Math.max(2, Math.floor(host.clientWidth / cellW));
      const rows = Math.max(1, Math.floor(host.clientHeight / cellH));
      fitCanvas();
      paintAll(); // repaint from local state (pane may have been hidden at 0x0)
      if (cols !== grid.cols || rows !== grid.rows) {
        grid.cols = cols;
        grid.rows = rows;
        void invoke("term_resize", {
          termId,
          cols,
          rows,
          cellWidth: Math.round(cellW),
          cellHeight: cellH,
        });
      }
      if (wasHidden) {
        // Ask for one full frame — the engine never resends clean rows.
        wasHidden = false;
        void invoke("term_visibility", { termId, visible: true });
        void invoke("term_request_full", { termId });
      }
    });
    observer.observe(host);

    return () => {
      disposed = true;
      bridgeRef.current = null;
      searchRef.current = { matches: [], current: -1 };
      observer.disconnect();
      for (const dispose of disposers) dispose();
      for (const unlisten of unlisteners) unlisten();
      if (started) void invoke("term_kill", { termId });
    };
    // termId/cwd identify the shell; changing them means a different terminal.
  }, [termId, cwd, copyOnSelectRef, shortcutsWorkInTerminalRef]);

  return (
    <div ref={hostRef} className="relative size-full overflow-hidden bg-background p-1">
      {/* Right-click menu; items route through `bridgeRef`. `onCloseAutoFocus`
          returns focus to the hidden input so typing/IME keep working. */}
      <ContextMenu
        onOpenChange={(open) => {
          if (open) setCopyEnabled(bridgeRef.current?.hasSelection() ?? false);
        }}
      >
        <ContextMenuTrigger asChild>
          <canvas
            ref={canvasRef}
            className="block"
            onContextMenu={(e) =>
              setMenuLink(
                bridgeRef.current?.linkAtPoint(e.nativeEvent.offsetX, e.nativeEvent.offsetY) ??
                  null,
              )
            }
          />
        </ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            bridgeRef.current?.focusTerm();
          }}
        >
          {menuLink && (
            <>
              <ContextMenuItem
                onSelect={() =>
                  menuLink.kind === "url"
                    ? void openExternalUrl(menuLink.url)
                    : bridgeRef.current?.openPath(menuLink)
                }
              >
                {menuLink.kind === "url"
                  ? "Open link"
                  : onOpenPath
                    ? "Open in files"
                    : "Open in editor"}
              </ContextMenuItem>
              {menuLink.kind === "path" && onOpenPath && (
                <ContextMenuItem onSelect={() => openPathInEditor(menuLink)}>
                  Open in editor
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem disabled={!copyEnabled} onSelect={() => bridgeRef.current?.copy()}>
            Copy
            <ContextMenuShortcut>{IS_MAC ? "⇧⌘C" : "Ctrl+Shift+C"}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => bridgeRef.current?.paste()}>Paste</ContextMenuItem>
          <ContextMenuItem onSelect={() => bridgeRef.current?.selectAll()}>
            Select all
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setSearchOpen(true)}>
            Search scrollback
            <ContextMenuShortcut>{IS_MAC ? "⇧⌘F" : "Ctrl+Shift+F"}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => bridgeRef.current?.clearScrollback()}>
            Clear scrollback
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {/* Scrollback search overlay (Ctrl/⌘+Shift+F). Enter/Shift+Enter step
          through matches; Escape returns focus to the terminal. */}
      {searchOpen && (
        <div className="absolute right-1 top-1 z-10 flex items-center gap-1 rounded-md border bg-card p-1 shadow-md">
          <Input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape" || matchesShortcut("term-search", e.nativeEvent)) {
                e.preventDefault();
                closeSearch();
              }
            }}
            placeholder="Search scrollback"
            className="h-6 w-44 px-2 text-xs md:text-xs"
            spellCheck={false}
            aria-label="search scrollback"
          />
          <span className="min-w-10 text-center font-mono text-[10px] tabular-nums text-muted-foreground">
            {matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : "0/0"}
          </span>
          <IconBtn title="Previous match (Shift+Enter)" onClick={() => step(-1)}>
            <ChevronUp className="size-3" />
          </IconBtn>
          <IconBtn title="Next match (Enter)" onClick={() => step(1)}>
            <ChevronDown className="size-3" />
          </IconBtn>
          <IconBtn title="Close search (Esc)" onClick={closeSearch}>
            <X className="size-3" />
          </IconBtn>
        </div>
      )}
      {/* Confirm a multi-line paste the engine held back: the shell has no
          bracketed paste, so every line would run the moment it lands. */}
      <AlertDialog
        open={pendingPaste !== null}
        onOpenChange={(open) => {
          if (!open) setPendingPaste(null);
        }}
      >
        <AlertDialogContent onCloseAutoFocus={() => bridgeRef.current?.focusTerm()}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Paste {pendingPaste?.split("\n").length ?? 0} lines?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This shell isn't guarding pastes (no bracketed paste), so each line runs as soon as it
              arrives — including the last one if it ends with a newline.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmPaste}>Paste</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Hidden input: receives focus/keystrokes/IME composition/paste. */}
      <textarea
        ref={inputRef}
        className="absolute left-0 top-0 h-px w-px resize-none border-0 bg-transparent p-0 opacity-0 outline-none"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label="terminal input"
      />
    </div>
  );
}

/** The character at terminal column `x` in a row of runs, if any. */
function charAt(runs: Run[], x: number): string | null {
  for (const run of runs) {
    if (x < run.x || x >= run.x + run.width) continue;
    const clusters = graphemeClusters(run.text);
    if (!isWideRun(run)) return clusters[x - run.x] ?? null;
    let cx = run.x;
    for (const cluster of clusters) {
      const w = (cluster.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
      if (x >= cx && x < cx + w) return cluster;
      cx += w;
    }
  }
  return null;
}
