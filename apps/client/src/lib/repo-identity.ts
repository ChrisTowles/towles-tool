/** Per-repo chosen icon + color. The persisted `meta` blob is **untrusted**: an
 * unknown icon or malformed color degrades to the default look and never invents
 * a fallback. `repoAccentStyles` is the one seam turning a hex into pixels. */
import {
  Anchor,
  BookOpen,
  Bot,
  Boxes,
  Brain,
  Bug,
  Cloud,
  Code,
  Cog,
  Compass,
  Container,
  Cpu,
  Database,
  FlaskConical,
  FolderGit2,
  Gauge,
  Globe,
  Hammer,
  Layers,
  Leaf,
  Package,
  Palette,
  Plane,
  Puzzle,
  Radio,
  Rocket,
  Server,
  Shield,
  Sparkles,
  Terminal,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";

/** `accent` (the default) is edge + tinted glyph; `tint` adds a background wash. */
export type RepoIdentityStyle = "accent" | "tint";

export type RepoMeta = {
  icon?: string;
  color?: string;
  style?: RepoIdentityStyle;
};

/** Keys are lucide component names, which is what gets persisted. Adding one
 * here is the only way to make it selectable. */
export const REPO_ICONS: Record<string, LucideIcon> = {
  FolderGit2,
  Rocket,
  Bug,
  Boxes,
  Terminal,
  Cloud,
  Database,
  Cpu,
  Globe,
  BookOpen,
  Wrench,
  FlaskConical,
  Palette,
  Zap,
  Shield,
  Package,
  Server,
  Code,
  Layers,
  Sparkles,
  Hammer,
  Radio,
  Compass,
  Bot,
  Plane,
  Cog,
  Anchor,
  Brain,
  Container,
  Gauge,
  Leaf,
  Puzzle,
};

export const DEFAULT_REPO_ICON: LucideIcon = FolderGit2;

/** Mid-chroma so they stay legible on either surface, and clear of the rail's
 * reserved status hues — amber (needs-you), violet (agent/focus), sky-500
 * (primary checkout) — so decoration can't be mistaken for a signal. */
export const REPO_PALETTE: readonly string[] = [
  "#e11d48",
  "#ec4899",
  "#d946ef",
  "#3b82f6",
  "#0891b2",
  "#14b8a6",
  "#059669",
  "#65a30d",
  "#78716c",
];

export function repoIcon(meta: RepoMeta | null | undefined): LucideIcon {
  const name = meta?.icon;
  if (!name) return DEFAULT_REPO_ICON;
  return REPO_ICONS[name] ?? DEFAULT_REPO_ICON;
}

const HEX_RE = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Mirrors the Rust color parser: `#rgb` or `#rrggbb`, the `#` optional. */
export function isHexColor(s: string): boolean {
  return HEX_RE.test(s.trim());
}

/** Canonicalize to lowercase `#rrggbb`, or `null` when it isn't a color. */
export function normalizeHex(s: string): string | null {
  const raw = s.trim();
  if (!isHexColor(raw)) return null;
  const body = (raw.startsWith("#") ? raw.slice(1) : raw).toLowerCase();
  if (body.length === 3) {
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  }
  return `#${body}`;
}

/** Every field is `undefined` for an unthemed repo, so a call site can spread
 * them unconditionally. `iconStyle` replaces `text-muted-foreground`;
 * `edgeStyle` applies only when no status accent owns the edge, since identity
 * never outranks attention. */
export type RepoAccentStyles = {
  iconStyle: CSSProperties | undefined;
  edgeStyle: CSSProperties | undefined;
  surfaceStyle: CSSProperties | undefined;
};

const EMPTY_ACCENT: RepoAccentStyles = {
  iconStyle: undefined,
  edgeStyle: undefined,
  surfaceStyle: undefined,
};

export function repoAccentStyles(
  meta: RepoMeta | null | undefined,
  /** What the tint wash mixes into. A **sticky** surface (rows scroll under
   * the rail's repo header) must stay opaque and pass `"var(--card)"`. */
  base = "transparent",
): RepoAccentStyles {
  const hex = meta?.color ? normalizeHex(meta.color) : null;
  if (!hex) return EMPTY_ACCENT;
  const style: RepoIdentityStyle = meta?.style ?? "accent";
  return {
    iconStyle: { color: hex },
    edgeStyle: { borderLeftColor: `color-mix(in srgb, ${hex} 70%, transparent)` },
    surfaceStyle:
      style === "tint" ? { backgroundColor: `color-mix(in srgb, ${hex} 8%, ${base})` } : undefined,
  };
}

/** The cheap test for whether to drop `text-muted-foreground`. */
export function hasRepoColor(meta: RepoMeta | null | undefined): boolean {
  return meta?.color ? normalizeHex(meta.color) !== null : false;
}
