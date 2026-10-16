import { invoke } from "@/lib/tauri";
import { claudeCommand, promptWithImages } from "@/lib/agentboard/claude-command";
import { isAgent } from "@/lib/agentboard/session";
import type { FolderData } from "@/lib/agentboard/types";
import { devServerUrl, type LaunchConfigStatus } from "@/lib/launch";

/** A dev server detected from a tracked checkout's `.claude/launch.json`. */
export type DevServer = {
  key: string;
  label: string;
  url: string;
  listening: boolean;
  folderDir: string;
};

/** Port-less configs are dropped — they can't be probed or previewed. */
export function devServersOf(
  repoName: string,
  folderDir: string,
  configs: LaunchConfigStatus[],
): DevServer[] {
  return configs
    .filter((cfg) => cfg.port != null)
    .map((cfg) => ({
      key: `${folderDir}\0${cfg.name}`,
      label: `${repoName} · ${cfg.name} :${cfg.port}`,
      url: devServerUrl(cfg.port as number),
      listening: cfg.portListening,
      folderDir,
    }));
}

/** Viewport rect in CSS pixels plus the DPR mapping it into device pixels —
 * mirrors `CaptureRect` in `crates-tauri/tt-app/src/preview.rs`. */
export type CaptureRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  devicePixelRatio: number;
};

/** Base64 PNG. Capture lives in the backend because the DOM can't screenshot
 * a cross-origin iframe — see the module docs in `preview.rs`. */
export const previewCapture = (rect: CaptureRect) =>
  invoke<string>("preview_capture", { rect }, { timeoutMs: 15_000 });

/** The persisted subset of agentboard's `PastedImage`, minus UI-only fields. */
export type FeedbackImage = { mime: string; dataBase64: string };

/** Stage the annotated capture as files under the pasted-images dir (outside
 * any repo), returning absolute paths for the note or the launch. */
export const previewWriteFeedback = (repo: string, images: FeedbackImage[]) =>
  invoke<string[]>("preview_write_feedback", { repo, images });

// Annotation model

export type Point = { x: number; y: number };

export type AnnotationTool = "pen" | "line" | "rect" | "ellipse" | "text";

/** One drawn mark, in the preview surface's CSS pixels. `pen` holds the full
 * trail, `line`/`rect`/`ellipse` `[from, to]`, `text` `[anchor]` plus `text`. */
export type Annotation = {
  tool: AnnotationTool;
  color: string;
  points: Point[];
  text?: string;
};

/** Raw hex, not Tailwind: these are canvas strokes and must reach the PNG
 * identically in both themes. Red first — the default is "this is broken". */
export const ANNOTATION_COLORS = ["#ef4444", "#22c55e", "#3b82f6", "#eab308"] as const;

const ANNOTATION_STROKE_WIDTH = 3;
export const ANNOTATION_FONT = "600 14px system-ui, sans-serif";

/** Normalize two drag corners into a positive-size rect. */
export function normRect(a: Point, b: Point): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/** Paint one annotation. `scale` maps CSS-pixel coordinates to the canvas
 * backing store (the devicePixelRatio the canvas was sized with). */
export function drawAnnotation(ctx: CanvasRenderingContext2D, a: Annotation, scale: number): void {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = ANNOTATION_STROKE_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const [first] = a.points;
  if (!first) {
    ctx.restore();
    return;
  }
  switch (a.tool) {
    case "pen": {
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (const p of a.points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
      break;
    }
    case "line": {
      const to = a.points.at(-1) ?? first;
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      break;
    }
    case "rect": {
      const r = normRect(first, a.points.at(-1) ?? first);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case "ellipse": {
      const r = normRect(first, a.points.at(-1) ?? first);
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "text": {
      ctx.font = ANNOTATION_FONT;
      ctx.textBaseline = "top";
      ctx.fillText(a.text ?? "", first.x, first.y);
      break;
    }
  }
  ctx.restore();
}

// Feedback composition + delivery

/** The note a running agent gets; the screenshot rides as the note's image. */
export function feedbackNote(comment: string, url: string): string {
  return `${comment.trim() || "Please address the annotated feedback"} (annotated screenshot of the app preview at ${url})`;
}

/** A plain shell gets a `claude '<prompt>'` launch, newline-free: a literal newline
 * inside the quoted argv drops zsh to a PS2 continuation prompt. */
export function feedbackLaunch(comment: string, url: string, paths: string[]): string {
  const flat = feedbackNote(comment.replaceAll(/\s*\n\s*/g, " "), url);
  return claudeCommand(promptWithImages(flat, paths));
}

/** How feedback reaches a session: a note to an agent whose tt mod is listening, a
 * `claude` launch in a plain shell, or nothing — an agent without the mod is never
 * typed into, since its input box may hold a half-written prompt. */
type SendMode = "note" | "launch" | "unreachable";

/** Only `live` sessions qualify — a session never started has no PTY to reach
 * ("A pane has no PTY until it is rendered", apps/client/CLAUDE.md). */
export type SendTarget = {
  sessionId: string;
  label: string;
  agentRunning: boolean;
  mode: SendMode;
};

/** Scoped to one folder: the preview belongs to a task, so its feedback goes
 * to that task's session. Claude sessions first — usually the intended one. */
export function folderSendTargets(
  folder: Pick<FolderData, "sessions"> | undefined,
  listening: readonly string[],
): SendTarget[] {
  if (!folder) return [];
  return folder.sessions
    .filter((s) => s.live)
    .map((s): SendTarget => {
      const agentRunning = isAgent(s);
      const mode = !agentRunning ? "launch" : listening.includes(s.id) ? "note" : "unreachable";
      return { sessionId: s.id, label: s.name, agentRunning, mode };
    })
    .toSorted((a, b) => Number(b.agentRunning) - Number(a.agentRunning));
}
