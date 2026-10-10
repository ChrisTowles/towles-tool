/** Draw-on-page annotation, shared by the preview and Chrome panes. They
 * differ only in `capture`: a WebKit snapshot already contains the ink, a CDP
 * screenshot does not — hence `compositeInk`. */
import { Button, Dialog, InputArea, Select } from "@cloudflare/kumo";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleIcon,
  LineSegmentIcon,
  PaperPlaneTiltIcon,
  PenIcon,
  SquareIcon,
  TextTIcon,
} from "@phosphor-icons/react";
import { toast } from "@/lib/toast";
import { Glyph } from "@/components/agentboard-bits";
import { Separator } from "@/components/ui/separator";
import { type FolderData, termWriteRetry } from "@/lib/agentboard";
import { errorMessage, type IpcError } from "@/lib/errors";
import {
  ANNOTATION_COLORS,
  ANNOTATION_FONT,
  type Annotation,
  type AnnotationTool,
  drawAnnotation,
  feedbackPrompt,
  feedbackPtyData,
  folderSendTargets,
  previewWriteFeedback,
} from "@/lib/preview";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";
import type { Result } from "better-result";

const TOOLS: { tool: AnnotationTool; icon: typeof PenIcon; title: string }[] = [
  { tool: "pen", icon: PenIcon, title: "Draw freehand" },
  { tool: "line", icon: LineSegmentIcon, title: "Line" },
  { tool: "rect", icon: SquareIcon, title: "Rectangle" },
  { tool: "ellipse", icon: CircleIcon, title: "Ellipse" },
  { tool: "text", icon: TextTIcon, title: "Text note" },
];

function pointFrom(e: React.PointerEvent<HTMLCanvasElement>) {
  return { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
}

export type CaptureFn = (rect: DOMRect) => Promise<Result<string, IpcError>>;

export function AnnotateSurface({
  folder,
  capture,
  compositeInk = false,
  sourceLabel,
  enabled,
  telemetryPrefix,
  children,
}: {
  folder: FolderData | undefined;
  /** Returns a base64 PNG of what the pane is showing. */
  capture: CaptureFn;
  /** True when `capture` returns pixels without the ink drawn in. */
  compositeInk?: boolean;
  /** Names the screenshot's origin in the prompt sent to the agent. */
  sourceLabel: string;
  /** False disables the tools — there is nothing on screen to mark up. */
  enabled: boolean;
  telemetryPrefix: string;
  children: React.ReactNode;
}) {
  const [tool, setTool] = useState<AnnotationTool | null>(null);
  const [color, setColor] = useState<string>(ANNOTATION_COLORS[0]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(null);

  const [captured, setCaptured] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draftRef = useRef<Annotation | null>(null);
  const redrawRef = useRef<() => void>(() => {});

  const targets = useMemo(() => folderSendTargets(folder), [folder]);

  // The in-progress stroke lives only in `draftRef`, painted imperatively: a
  // `setDraft` per pointermove would re-render every move and drop points.
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
    setAnnotations([]);
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
    uiAction(`${telemetryPrefix}.feedback.capture`, "agentboard");
    const res = await capture(surface.getBoundingClientRect());
    const shot = res.match({
      ok: (png) => png,
      err: (e) => {
        toast.error(`Capture failed: ${errorMessage(e)}`);
        return null;
      },
    });
    if (shot === null) return;
    const rect = surface.getBoundingClientRect();
    setCaptured(compositeInk ? await withInk(shot, annotations, rect.width) : shot);
    setComment("");
    setTargetId(targets.at(0)?.sessionId ?? null);
  }

  async function sendFeedback() {
    if (!captured || !folder) return;
    const target = targets.find((t) => t.sessionId === targetId);
    if (!target) {
      toast.error("That session is no longer running — pick another.");
      return;
    }
    setSending(true);
    const written = await previewWriteFeedback(folder.name, [
      { mime: "image/png", dataBase64: captured },
    ]);
    if (written.isErr()) {
      setSending(false);
      uiAction(`${telemetryPrefix}.feedback.send`, "agentboard", "err");
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
        uiAction(`${telemetryPrefix}.feedback.send`, "agentboard", "ok");
        toast.success(`Sent to ${target.label}`);
        setCaptured(null);
        setAnnotations([]);
        setTool(null);
      },
      err: (e) => {
        uiAction(`${telemetryPrefix}.feedback.send`, "agentboard", "err");
        toast.error(`Send failed: ${errorMessage(e)}`);
      },
    });
  }

  return (
    <>
      <div ref={surfaceRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
        {children}
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

      <div className="flex shrink-0 items-center gap-1 border-t border-kumo-hairline bg-kumo-base px-2 py-1">
        {TOOLS.map(({ tool: t, icon: Icon, title }) => (
          <Button
            key={t}
            variant="ghost"
            shape="square"
            size="sm"
            title={title}
            aria-label={title}
            disabled={!enabled}
            className={cn(tool === t && "bg-kumo-tint")}
            onClick={() => selectTool(tool === t ? null : t)}
            icon={<Icon className="size-3.5" />}
          />
        ))}
        <Separator orientation="vertical" className="mx-0.5 h-4" />
        {ANNOTATION_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            title="Ink color"
            className={cn(
              "size-3.5 rounded-full border border-kumo-hairline",
              color === c && "ring-2 ring-kumo-focus ring-offset-1 ring-offset-kumo-base",
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
          <Button
            variant="primary"
            size="xs"
            disabled={!enabled}
            icon={<PaperPlaneTiltIcon />}
            onClick={() => void openSendDialog()}
          >
            Send to agent
          </Button>
        </div>
      </div>

      <Dialog.Root open={captured != null} onOpenChange={(open) => !open && setCaptured(null)}>
        <Dialog size="lg" className="flex flex-col gap-4 p-6">
          <div className="flex flex-col gap-1.5">
            <Dialog.Title className="text-lg font-semibold">Send annotated feedback</Dialog.Title>
            <Dialog.Description className="text-sm text-kumo-subtle">
              The screenshot below (with your markup) is staged as a file and its path typed into
              the session&apos;s prompt.
            </Dialog.Description>
          </div>
          {captured && (
            <img
              src={`data:image/png;base64,${captured}`}
              alt="Annotated capture"
              className="max-h-64 w-full rounded-md border border-kumo-hairline object-contain"
            />
          )}
          <InputArea
            aria-label="Comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What should the agent do about it?"
            rows={2}
          />
          {targets.length > 1 ? (
            <Select
              aria-label="Send to session"
              className="w-full"
              placeholder="Send to session…"
              value={targetId}
              onValueChange={(id) => setTargetId(id as string | null)}
              items={targets.map((t) => ({
                value: t.sessionId,
                label: (
                  <span className="flex items-center gap-1.5">
                    <Glyph agent={t.agentRunning} />
                    {t.label}
                  </span>
                ),
              }))}
            />
          ) : targets.length === 0 ? (
            <div className="text-xs text-kumo-subtle">
              No live session in this checkout — start one in the rail first.
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCaptured(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={sending || !targetId}
              onClick={() => void sendFeedback()}
            >
              {sending ? "Sending…" : "Send"}
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  );
}

/** Flatten the ink onto a screenshot that lacks it. Strokes are in pane CSS
 * px and the image is in page device px, so it scales by their ratio rather
 * than by devicePixelRatio — the two diverge whenever a resize is in flight. */
async function withInk(
  pngBase64: string,
  annotations: Annotation[],
  surfaceCssWidth: number,
): Promise<string> {
  if (!annotations.length) return pngBase64;
  const image = new Image();
  image.src = `data:image/png;base64,${pngBase64}`;
  try {
    await image.decode();
  } catch {
    return pngBase64;
  }
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return pngBase64;
  ctx.drawImage(image, 0, 0);
  const scale = surfaceCssWidth > 0 ? image.naturalWidth / surfaceCssWidth : 1;
  for (const a of annotations) drawAnnotation(ctx, a, scale);
  return canvas.toDataURL("image/png").split(",")[1] ?? pngBase64;
}
