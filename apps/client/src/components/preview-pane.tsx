import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  Circle,
  ExternalLink,
  FileCode2,
  Pen,
  RotateCw,
  Send,
  Slash,
  Square,
  Type,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Glyph, IconBtn, PanePlaceholder } from "@/components/agentboard-bits";
import { PaneChrome, PaneLens } from "@/components/pane-chrome";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { type FolderData, termWriteRetry } from "@/lib/agentboard";
import { errorMessage } from "@/lib/errors";
import { launchConfigs } from "@/lib/launch";
import { openExternalUrl } from "@/lib/open-url";
import { PreviewDocView } from "@/components/preview-doc";
import {
  fileUrl,
  onPreviewFileChanged,
  type PreviewDoc,
  type PreviewRequest,
  previewReadFile,
  previewUnwatchFile,
  previewWatchFile,
  typedPreviewRequest,
} from "@/lib/preview-artifact";
import {
  ANNOTATION_COLORS,
  ANNOTATION_FONT,
  type Annotation,
  type AnnotationTool,
  type DevServer,
  devServersOf,
  drawAnnotation,
  feedbackPrompt,
  feedbackPtyData,
  folderSendTargets,
  previewCapture,
  previewWriteFeedback,
} from "@/lib/preview";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

const TOOLS: { tool: AnnotationTool; icon: typeof Pen; title: string }[] = [
  { tool: "pen", icon: Pen, title: "Draw freehand" },
  { tool: "line", icon: Slash, title: "Line" },
  { tool: "rect", icon: Square, title: "Rectangle" },
  { tool: "ellipse", icon: Circle, title: "Ellipse" },
  { tool: "text", icon: Type, title: "Text note" },
];

function pointFrom(e: React.PointerEvent<HTMLCanvasElement>) {
  return { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
}

/** A task's live dev server — or a file its agent pointed at with the
 * `preview_file` MCP tool, re-read on every change — beside its terminals, with
 * draw-on-page annotation sent back to that task's own session as a screenshot.
 * One surface for both, so you can circle the agent's own plan and reply to it. */
export function PreviewPane({
  folder,
  focused,
  file: pushed,
  onClose,
}: {
  /** The checkout this pane previews; undefined when it left the rail. */
  folder: FolderData | undefined;
  /** See the focus-ring rule in `screens/agentboard.tsx`'s `focusedPaneId`. */
  focused: boolean;
  /** The file this folder's agent last asked to show. Its `nonce` changes per
   * `preview_file` call, so re-showing a rewritten file re-reads it. */
  file?: PreviewRequest;
  /** Removes the pane from its window. */
  onClose: () => void;
}) {
  const dir = folder?.dir;

  // URL / navigation
  const [url, setUrl] = useState("");
  const [input, setInput] = useState("");
  const [frameKey, setFrameKey] = useState(0);
  const [servers, setServers] = useState<DevServer[]>([]);

  // shown file (agent → user). Two flags rather than a union: the dev server's
  // URL must survive a look at a file, so going back is a click, not a re-probe.
  const [doc, setDoc] = useState<PreviewDoc | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [showing, setShowing] = useState<"server" | "file">("server");
  // A path the user typed shows instead of the agent's, until the agent pushes a
  // *new* one — the whole point of a push is that it lands.
  const [typed, setTyped] = useState<PreviewRequest | null>(null);
  const [pathInput, setPathInput] = useState("");
  const file = typed ?? pushed;

  // annotation
  const [tool, setTool] = useState<AnnotationTool | null>(null);
  const [color, setColor] = useState<string>(ANNOTATION_COLORS[0]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(null);

  // send dialog
  const [capture, setCapture] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draftRef = useRef<Annotation | null>(null);
  const redrawRef = useRef<() => void>(() => {});

  const targets = useMemo(() => folderSendTargets(folder), [folder]);

  // This folder's dev servers, from its launch.json, auto-loading the first
  // listening one. Owns a timer per pane — unlike diff-pane, which refetches off
  // the shared poll's `statsKey` — because launch.json and port status aren't in
  // the agentboard snapshot. Put them there and this timer goes.
  useEffect(() => {
    if (!dir) return;
    let cancelled = false;
    const probe = async () => {
      const res = await launchConfigs(dir);
      if (cancelled) return;
      const found = res.isOk() ? devServersOf(folder?.name ?? "", dir, res.value) : [];
      setServers(found);
      setUrl((cur) => {
        if (cur) return cur;
        const auto = found.find((s) => s.listening) ?? found[0];
        return auto?.url ?? cur;
      });
    };
    void probe();
    const timer = setInterval(() => void probe(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // folder?.name only feeds labels; dir is the identity that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-probe only on a changed dir, not when the label-only folder name changes
  }, [dir]);

  // Read + watch the shown file, keyed on the nonce so a rewrite of the same
  // path re-reads. A hot reload keeps the old content up until the new read
  // lands: an agent's rewrite is not atomic, and a flash of error is worse.
  const pushedNonce = pushed?.nonce;
  useEffect(() => setTyped(null), [pushedNonce]);

  const filePath = file?.path;
  const fileNonce = file?.nonce;
  // Follows what's on screen; a hot reload changes content, never the path.
  useEffect(() => setPathInput(filePath ?? ""), [filePath]);
  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    const readFile = async (initial: boolean) => {
      const res = await previewReadFile(filePath);
      if (cancelled) return;
      res.match({
        ok: (loaded) => {
          setDoc(loaded);
          setDocError(null);
          if (initial) setShowing("file");
        },
        err: (e) => {
          // In the pane, not a toast: it's what the agent said to look at. The
          // old doc goes too, else `sourceLabel` names what isn't on screen.
          if (!initial) return;
          setDoc(null);
          setDocError(errorMessage(e));
          setShowing("file");
        },
      });
    };
    void readFile(true);
    void previewWatchFile(filePath);
    const off = onPreviewFileChanged(filePath, () => void readFile(false));
    return () => {
      cancelled = true;
      off();
      void previewUnwatchFile(filePath);
    };
  }, [filePath, fileNonce]);

  /** The reload button's file half — and the only way back from a failed first
   * read, which no watch covers: a path that never existed has nothing to watch. */
  async function reloadFile() {
    if (!filePath) return;
    const res = await previewReadFile(filePath);
    res.match({
      ok: (loaded) => {
        setDoc(loaded);
        setDocError(null);
      },
      err: (e) => {
        setDoc(null);
        setDocError(errorMessage(e));
      },
    });
  }

  function navigate(next: string, source: "manual" | "config") {
    const withScheme = /^[a-z]+:\/\//i.test(next) ? next : `http://${next}`;
    // Navigating is also how you leave a shown file behind.
    setShowing("server");
    setUrl(withScheme);
    setInput(withScheme);
    setFrameKey((k) => k + 1);
    uiAction("preview.navigate", "agentboard", source);
  }

  // The in-progress stroke lives only in `draftRef`, painted imperatively: a
  // `setDraft` per pointermove would re-render the pane every move, and reading
  // it back from state would drop points (several moves per render). Committed
  // `annotations` are state and repaint via the effect below.
  function redraw() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const a of annotations) drawAnnotation(ctx, a, dpr);
    if (draftRef.current) drawAnnotation(ctx, draftRef.current, dpr);
  }
  redrawRef.current = redraw;

  useEffect(() => {
    const canvas = canvasRef.current;
    const surface = surfaceRef.current;
    if (!canvas || !surface) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = surface.getBoundingClientRect();
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      redrawRef.current();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(surface);
    resize();
    return () => ro.disconnect();
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- repaint on committed annotations only; redraw is recreated every render and reads them fresh
  useEffect(redraw, [annotations]);

  // Shared "escape the draft": Escape, tool-switch and clear all use it.
  function discardDraft() {
    draftRef.current = null;
    redrawRef.current();
  }

  useEffect(() => {
    if (!tool) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (textDraft) setTextDraft(null);
      else if (draftRef.current) discardDraft();
      else setTool(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, textDraft]);

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!tool || e.button !== 0) return;
    const p = pointFrom(e);
    if (tool === "text") {
      commitTextDraft();
      setTextDraft({ x: p.x, y: p.y, value: "" });
      return;
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    draftRef.current = { tool, color, points: [p] };
    redrawRef.current();
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = draftRef.current;
    if (!d) return;
    const p = pointFrom(e);
    draftRef.current =
      d.tool === "pen" ? { ...d, points: [...d.points, p] } : { ...d, points: [d.points[0], p] };
    redrawRef.current();
  }

  function onPointerUp() {
    const d = draftRef.current;
    if (!d) return;
    draftRef.current = null;
    // The imperative frame stays up until the effect repaints it — no flicker.
    setAnnotations((all) => [...all, d]);
  }

  // Two top-level setStates — nesting setAnnotations inside a setTextDraft
  // updater would duplicate the note under StrictMode's double-invoke.
  function commitTextDraft() {
    const td = textDraft;
    if (td && td.value.trim()) {
      setAnnotations((all) => [
        ...all,
        { tool: "text", color, points: [{ x: td.x, y: td.y }], text: td.value.trim() },
      ]);
    }
    setTextDraft(null);
  }

  function clearAnnotations() {
    draftRef.current = null;
    setTextDraft(null);
    setAnnotations([]); // effect repaints the now-empty canvas
  }

  function selectTool(next: AnnotationTool | null) {
    commitTextDraft();
    discardDraft();
    setTool(next);
  }

  async function openSendDialog() {
    const surface = surfaceRef.current;
    if (!surface) return;
    commitTextDraft();
    uiAction("preview.feedback.capture", "agentboard");
    const r = surface.getBoundingClientRect();
    const res = await previewCapture({
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
    res.match({
      ok: (png) => {
        setCapture(png);
        setComment("");
        setTargetId(targets.at(0)?.sessionId ?? null);
      },
      err: (e) => toast.error(`Capture failed: ${errorMessage(e)}`),
    });
  }

  async function sendFeedback() {
    if (!capture || !dir) return;
    const target = targets.find((t) => t.sessionId === targetId);
    if (!target) {
      toast.error("That session is no longer running — pick another.");
      return;
    }
    setSending(true);
    const written = await previewWriteFeedback(folder?.name ?? "preview", [
      { mime: "image/png", dataBase64: capture },
    ]);
    if (written.isErr()) {
      setSending(false);
      uiAction("preview.feedback.send", "agentboard", "err");
      toast.error(`Send failed: ${errorMessage(written.error)}`);
      return;
    }
    const prompt = feedbackPrompt(comment, sourceLabel, written.value);
    const sent = await termWriteRetry(
      target.sessionId,
      feedbackPtyData(prompt, target.agentRunning),
    );
    setSending(false);
    sent.match({
      ok: () => {
        uiAction("preview.feedback.send", "agentboard", "ok");
        toast.success(`Sent to ${target.label}`);
        setCapture(null);
        setAnnotations([]);
        setTool(null);
      },
      err: (e) => {
        uiAction("preview.feedback.send", "agentboard", "err");
        toast.error(`Send failed: ${errorMessage(e)}`);
      },
    });
  }

  // The annotation tools are about the *pixels*, so they light up for either
  // kind of content and stay dark for neither.
  const onFile = showing === "file" && file != null;
  const hasSurface = onFile ? doc != null : url !== "";
  // Reload must survive a failed read, or a call made a beat before the file was
  // written leaves the pane an error with its retry button disabled.
  const canReload = onFile ? filePath != null : url !== "";
  // Names the annotated screenshot's source in the feedback prompt — while a
  // file is up, `url` is only whatever dev server the pane last pointed at.
  const sourceLabel = onFile ? (doc?.path ?? file.path) : url;

  if (!folder) return <PanePlaceholder label="folder gone" focused={focused} onRemove={onClose} />;

  return (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-lg border bg-card",
        focused && "border-violet-500/60",
      )}
    >
      {/* Header: title + URL/server + reload/external + close */}
      <PaneChrome
        lens={<PaneLens kind="web" />}
        controls={
          onFile ? (
            <>
              {/* Identity + an address bar for it; the way back to the dev
                  server is a click, not a retyped URL. */}
              <FileCode2 className="size-3 shrink-0 text-violet-500" />
              <span className="shrink-0 truncate text-[11px] font-medium">{file.title}</span>
              <Input
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setPathInput(filePath ?? "");
                  if (e.key !== "Enter") return;
                  const next = typedPreviewRequest(pathInput);
                  if (!next) {
                    toast.error("Enter an absolute path — the app has no working directory.");
                    return;
                  }
                  setTyped(next);
                  uiAction("preview.file.open_typed", "agentboard");
                }}
                placeholder="/absolute/path/to/file.md"
                title="show another file — absolute path, Enter to open"
                className="h-6 min-w-0 flex-1 font-mono text-[10px]"
              />
              {url && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto shrink-0"
                  onClick={() => {
                    setShowing("server");
                    uiAction("preview.file.dismiss", "agentboard");
                  }}
                >
                  Dev server
                </Button>
              )}
            </>
          ) : (
            <>
              {servers.length > 0 && (
                <Select
                  value={servers.find((s) => s.url === url)?.key ?? ""}
                  onValueChange={(key) => {
                    const s = servers.find((x) => x.key === key);
                    if (s) navigate(s.url, "config");
                  }}
                >
                  <SelectTrigger size="xs" className="w-40 text-[11px]">
                    <SelectValue placeholder="Dev server" />
                  </SelectTrigger>
                  <SelectContent>
                    {servers.map((s) => (
                      <SelectItem key={s.key} value={s.key}>
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            s.listening ? "bg-green-500" : "bg-muted-foreground/40",
                          )}
                        />
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && input.trim()) navigate(input.trim(), "manual");
                }}
                placeholder="http://localhost:<port>/"
                className="h-6 min-w-0 flex-1 font-mono text-[11px]"
              />
            </>
          )
        }
        actions={
          <>
            <IconBtn
              title={onFile ? "re-read the file from disk" : "reload preview"}
              disabled={!canReload}
              className="hover:text-sky-500"
              onClick={() => {
                if (onFile) void reloadFile();
                else setFrameKey((k) => k + 1);
                uiAction("preview.reload", "agentboard", onFile ? "file" : "server");
              }}
            >
              <RotateCw className="size-3" />
            </IconBtn>
            <IconBtn
              title="open in browser"
              disabled={!hasSurface}
              className="hover:text-sky-500"
              onClick={() => {
                uiAction("preview.open_external", "agentboard");
                void openExternalUrl(onFile ? fileUrl(sourceLabel) : url);
              }}
            >
              <ExternalLink className="size-3" />
            </IconBtn>
            <IconBtn
              title="close pane (preview stays a click away on the folder)"
              className="hover:text-sky-500"
              onClick={onClose}
            >
              <X className="size-3" />
            </IconBtn>
          </>
        }
      />

      {/* Surface: iframe + annotation canvas */}
      <div ref={surfaceRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
        {onFile ? (
          docError != null ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
              <FileCode2 className="size-6 text-muted-foreground/60" />
              <div className="text-xs text-muted-foreground">
                Couldn&apos;t read the file the agent pointed at — {docError}
              </div>
            </div>
          ) : doc != null ? (
            /* Keyed on path + nonce, never content: remounting an artifact's
             * frame per rewrite would drop its scroll and its scripts' state. */
            <PreviewDocView key={`${file.path}\u0000${file.nonce}`} doc={doc} title={file.title} />
          ) : null
        ) : url ? (
          /* Unsandboxed by intent: it's the user's own dev server and needs
           * scripts + its own origin (HMR, storage) — what the lint flags. */
          // oxlint-disable-next-line react/iframe-missing-sandbox
          <iframe
            key={frameKey}
            src={url}
            title="Dev server preview"
            className="absolute inset-0 h-full w-full border-0 bg-white"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <AppWindow className="size-6 text-muted-foreground/60" />
            <div className="text-xs text-muted-foreground">
              No dev server found in this checkout&apos;s{" "}
              <span className="font-mono">.claude/launch.json</span> — enter a URL above.
            </div>
          </div>
        )}
        <canvas
          ref={canvasRef}
          className={cn(
            "absolute inset-0 h-full w-full",
            tool === "text" ? "cursor-text" : "cursor-crosshair",
          )}
          style={{ pointerEvents: tool ? "auto" : "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
        {textDraft && (
          <input
            autoFocus
            value={textDraft.value}
            onChange={(e) => setTextDraft({ ...textDraft, value: e.target.value })}
            onBlur={commitTextDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTextDraft();
            }}
            className="absolute z-10 border border-dashed bg-transparent outline-none"
            style={{
              left: textDraft.x,
              top: textDraft.y,
              color,
              borderColor: color,
              font: ANNOTATION_FONT,
              minWidth: 100,
            }}
          />
        )}
      </div>

      {/* Annotation toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-t bg-card px-2 py-1">
        {TOOLS.map(({ tool: t, icon: Icon, title }) => (
          <Button
            key={t}
            variant="ghost"
            size="icon"
            title={title}
            disabled={!hasSurface}
            className={cn("size-6", tool === t && "bg-accent text-foreground")}
            onClick={() => selectTool(tool === t ? null : t)}
          >
            <Icon className="size-3.5" />
          </Button>
        ))}
        <Separator orientation="vertical" className="mx-0.5 h-4" />
        {ANNOTATION_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            title="Ink color"
            className={cn(
              "size-3.5 rounded-full border border-border",
              color === c && "ring-2 ring-ring ring-offset-1 ring-offset-card",
            )}
            style={{ backgroundColor: c }}
            onClick={() => setColor(c)}
          />
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          {annotations.length > 0 && (
            <Button variant="ghost" size="xs" onClick={clearAnnotations}>
              Clear
            </Button>
          )}
          <Button size="xs" disabled={!hasSurface} onClick={() => void openSendDialog()}>
            <Send /> Send to agent
          </Button>
        </div>
      </div>

      {/* Capture → comment → target dialog */}
      <Dialog open={capture != null} onOpenChange={(open) => !open && setCapture(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Send annotated feedback</DialogTitle>
            <DialogDescription>
              The screenshot below (with your markup) is staged as a file and its path typed into
              the session&apos;s prompt.
            </DialogDescription>
          </DialogHeader>
          {capture && (
            <img
              src={`data:image/png;base64,${capture}`}
              alt="Annotated preview capture"
              className="max-h-64 w-full rounded-md border border-border object-contain"
            />
          )}
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What should the agent do about it?"
            rows={2}
          />
          {targets.length > 1 ? (
            <Select value={targetId ?? ""} onValueChange={setTargetId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Send to session…" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((t) => (
                  <SelectItem key={t.sessionId} value={t.sessionId}>
                    <Glyph agent={t.agentRunning} />
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : targets.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              No live session in this checkout — start one in the rail first.
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCapture(null)}>
              Cancel
            </Button>
            <Button disabled={sending || !targetId} onClick={() => void sendFeedback()}>
              {sending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
