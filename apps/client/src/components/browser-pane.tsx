// A real headless Chrome on the app-owned profile, streamed onto a canvas over
// CDP. The process lives in Rust, so this is only a view and may unmount
// freely — the logins live in the profile directory.
import { useCallback, useEffect, useRef, useState } from "react";
import { AppWindow, ArrowLeft, ArrowRight, ExternalLink, Loader2, RotateCw, X } from "lucide-react";
import { IconBtn, PanePlaceholder } from "@/components/agentboard-bits";
import { AnnotateSurface } from "@/components/annotate-surface";
import { PaneChrome, PaneLens } from "@/components/pane-chrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { browserPaneId, type FolderData } from "@/lib/agentboard";
import {
  type BrowserState,
  browserCapture,
  browserClose,
  browserInput,
  browserNavigate,
  browserOpen,
  browserPopout,
  browserSetViewport,
  browserSetVisible,
  browserStatus,
  keyEvents,
  mouseEvent,
  normalizeUrl,
  subscribeBrowserState,
  wheelEvent,
  type BrowserInputEvent,
} from "@/lib/browser";
import { errorMessage, NotInTauri } from "@/lib/errors";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

/** Survives remounts (folder switches) for the session; disk-persistence of
 * the last URL is a follow-up (FolderMeta). */
const lastUrlByDir = new Map<string, string>();

/** The pane's whole onboarding: one line saying where these logins live.
 * localStorage, like the workspace's own tab state — a dismissed hint is UI
 * memory, not a setting worth a round trip. */
const HINT_KEY = "tt:browser-pane-hint-dismissed";

const CHIP = {
  live: "border-emerald-500/50 bg-emerald-500/10 text-emerald-500",
  starting: "border-muted-foreground/40 bg-muted text-muted-foreground",
  failed: "border-red-500/50 bg-red-500/10 text-red-500",
} as const;

export function BrowserPane({
  folder,
  focused,
  onClose,
}: {
  folder: FolderData | undefined;
  focused: boolean;
  onClose: () => void;
}) {
  const dir = folder?.dir ?? "";
  const paneId = browserPaneId(dir);
  const [state, setState] = useState<BrowserState | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [input, setInput] = useState(() => lastUrlByDir.get(dir) ?? "");
  const [editingUrl, setEditingUrl] = useState(false);
  const [openNonce, setOpenNonce] = useState(0);
  const [showHint, setShowHint] = useState(() => localStorage.getItem(HINT_KEY) === null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const frameSeq = useRef(0);
  const pendingMoves = useRef<BrowserInputEvent[]>([]);
  const moveRaf = useRef(0);

  const paint = useCallback((bitmap: ImageBitmap) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    ctx.drawImage(bitmap, 0, 0);
  }, []);

  useEffect(() => {
    if (!dir) return;
    let live = true;
    void (async () => {
      const status = (await browserStatus()).unwrapOr(null);
      if (!live) return;
      if (status && !status.chromeFound) {
        setUnavailable("No Chrome or Chromium found on this machine.");
        return;
      }
      const opened = await browserOpen(paneId, lastUrlByDir.get(dir), (bytes) => {
        const seq = ++frameSeq.current;
        void createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" })).then(
          (bitmap) => {
            if (!live || seq < frameSeq.current) return void bitmap.close();
            bitmapRef.current?.close();
            bitmapRef.current = bitmap;
            paint(bitmap);
          },
          () => {},
        );
      });
      if (live && opened.isErr() && !NotInTauri.is(opened.error)) {
        setUnavailable(errorMessage(opened.error));
      }
    })();
    return () => {
      live = false;
      bitmapRef.current?.close();
      bitmapRef.current = null;
      void browserClose(paneId);
    };
  }, [dir, paneId, paint, openNonce]);

  useEffect(() => {
    return subscribeBrowserState((next) => {
      if (next.paneId !== paneId) return;
      setState(next);
      if (next.url) {
        lastUrlByDir.set(dir, next.url);
        if (!editingUrl) setInput(next.url);
      }
    });
  }, [paneId, dir, editingUrl]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const push = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const rect = surface.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        void browserSetViewport(paneId, rect.width, rect.height, window.devicePixelRatio || 1);
      }, 150);
    };
    const ro = new ResizeObserver(push);
    ro.observe(surface);
    const io = new IntersectionObserver(([entry]) => {
      void browserSetVisible(paneId, entry?.isIntersecting ?? true);
    });
    io.observe(surface);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
      io.disconnect();
    };
  }, [paneId]);

  const send = useCallback(
    (events: BrowserInputEvent[]) => {
      if (events.length) void browserInput(paneId, events);
    },
    [paneId],
  );

  const origin = () => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect || rect.width < 1 || rect.height < 1) {
      return { left: 0, top: 0 };
    }
    const dpr = window.devicePixelRatio || 1;
    return {
      left: rect.left,
      top: rect.top,
      scaleX: canvas.width / dpr / rect.width,
      scaleY: canvas.height / dpr / rect.height,
    };
  };

  const dismissHint = () => {
    localStorage.setItem(HINT_KEY, "1");
    setShowHint(false);
  };

  const navigate = (raw: string) => {
    const url = normalizeUrl(raw);
    uiAction("browser.navigate", "agentboard");
    setInput(url);
    void browserNavigate(paneId, { url });
  };

  if (!folder) return <PanePlaceholder label="folder gone" onRemove={onClose} />;

  const phase = unavailable ? "failed" : (state?.phase ?? "launching");
  const chip =
    phase === "live" ? CHIP.live : phase === "crashed" || unavailable ? CHIP.failed : CHIP.starting;
  const chipLabel =
    phase === "live"
      ? "live"
      : phase === "crashed"
        ? "crashed"
        : unavailable
          ? "unavailable"
          : phase === "poppedOut"
            ? "popped out"
            : "starting";

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-lg border",
        focused ? "border-violet-500/60" : "border-border",
      )}
    >
      <PaneChrome
        lens={<PaneLens kind="browser" />}
        subject={
          <>
            <span
              className={cn(
                "flex h-4 shrink-0 items-center gap-1 rounded-full border px-1.5 font-mono text-[9.5px]",
                chip,
              )}
            >
              {phase === "launching" && <Loader2 className="size-2.5 animate-spin" />}
              {chipLabel}
            </span>
            <Input
              value={input}
              onFocus={() => setEditingUrl(true)}
              onBlur={() => setEditingUrl(false)}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && input.trim()) navigate(input.trim());
              }}
              placeholder="https://…  (sign-ins made here stick)"
              className="h-6 min-w-0 flex-1 font-mono text-[11px]"
            />
          </>
        }
        actions={
          <>
            <IconBtn
              title="back"
              disabled={!state?.canGoBack}
              onClick={() => void browserNavigate(paneId, { action: "back" })}
            >
              <ArrowLeft className="size-3" />
            </IconBtn>
            <IconBtn
              title="forward"
              disabled={!state?.canGoForward}
              onClick={() => void browserNavigate(paneId, { action: "forward" })}
            >
              <ArrowRight className="size-3" />
            </IconBtn>
            <IconBtn
              title="reload"
              disabled={phase !== "live"}
              className="hover:text-sky-500"
              onClick={() => void browserNavigate(paneId, { action: "reload" })}
            >
              <RotateCw className="size-3" />
            </IconBtn>
            <IconBtn
              title="open in a Chrome window (same profile; reattach restarts the embedded view)"
              disabled={phase !== "live"}
              className="hover:text-sky-500"
              onClick={() => {
                uiAction("browser.popout", "agentboard");
                void browserPopout(paneId);
              }}
            >
              <ExternalLink className="size-3" />
            </IconBtn>
            <IconBtn
              title="close pane"
              shortcut={focused ? "ab-close-pane" : undefined}
              className="hover:text-sky-500"
              onClick={onClose}
            >
              <X className="size-3" />
            </IconBtn>
          </>
        }
      />
      {showHint && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
          <span className="min-w-0 flex-1">
            Sign-ins made here stick — this pane keeps its own browser profile, separate from your
            personal Chrome.
          </span>
          <Button size="xs" variant="ghost" onClick={dismissHint}>
            Got it
          </Button>
        </div>
      )}
      <AnnotateSurface
        folder={folder}
        capture={() => browserCapture(paneId)}
        compositeInk
        sourceLabel={state?.url || "chrome pane"}
        enabled={phase === "live"}
        telemetryPrefix="browser"
      >
        <div ref={surfaceRef} className="absolute inset-0">
          {unavailable ? (
            <Empty icon>
              {unavailable} <span className="font-mono">TT_BROWSER_BIN</span> or Settings →
              Agentboard can point at one.
            </Empty>
          ) : phase === "crashed" ? (
            <Empty icon>
              Chrome stopped{state?.detail ? ` — ${state.detail}` : ""}.
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => setOpenNonce((n) => n + 1)}
              >
                Relaunch
              </Button>
            </Empty>
          ) : phase === "poppedOut" ? (
            <Empty icon>
              This page is open in its own Chrome window.
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => setOpenNonce((n) => n + 1)}
              >
                Reattach here
              </Button>
            </Empty>
          ) : (
            <canvas
              ref={canvasRef}
              tabIndex={0}
              className={cn(
                "absolute inset-0 h-full w-full outline-none",
                phase !== "live" && "opacity-40",
              )}
              onPointerDown={(e) => {
                e.currentTarget.focus();
                // Throws on an already-released pointer id; losing capture only
                // costs drag-outside-the-pane tracking, never the click.
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  /* keep the click */
                }
                send([mouseEvent("mousePressed", e, origin())]);
              }}
              onPointerUp={(e) => send([mouseEvent("mouseReleased", e, origin())])}
              onPointerMove={(e) => {
                pendingMoves.current.push(mouseEvent("mouseMoved", e, origin()));
                if (!moveRaf.current) {
                  moveRaf.current = requestAnimationFrame(() => {
                    moveRaf.current = 0;
                    const last = pendingMoves.current.at(-1);
                    pendingMoves.current = [];
                    if (last) send([last]);
                  });
                }
              }}
              onWheel={(e) => send([wheelEvent(e, origin())])}
              onKeyDown={(e) => {
                if (e.key === "Tab" && !e.ctrlKey && !e.metaKey) e.preventDefault();
                send(keyEvents("down", e));
              }}
              onKeyUp={(e) => send(keyEvents("up", e))}
            />
          )}
        </div>
      </AnnotateSurface>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode; icon?: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <AppWindow className="size-6 text-muted-foreground/60" />
      <div className="max-w-md text-xs text-muted-foreground">{children}</div>
    </div>
  );
}
