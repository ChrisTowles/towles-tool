/** Per-repo chosen icon + color. The persisted `meta` blob is **untrusted**: an
 * unknown icon or malformed color degrades to the default look, never a
 * fallback. This file is the one seam turning a hex into pixels. */
import {
  AirplaneTiltIcon,
  AnchorIcon,
  BookOpenIcon,
  BrainIcon,
  BroadcastIcon,
  BugIcon,
  CloudIcon,
  CodeIcon,
  CompassIcon,
  CpuIcon,
  CubeTransparentIcon,
  DatabaseIcon,
  FlaskIcon,
  GaugeIcon,
  GearIcon,
  GitBranchIcon,
  GlobeIcon,
  HammerIcon,
  HardDrivesIcon,
  LeafIcon,
  LightningIcon,
  PackageIcon,
  PaletteIcon,
  PuzzlePieceIcon,
  RobotIcon,
  RocketIcon,
  ShieldIcon,
  SparkleIcon,
  StackIcon,
  TerminalIcon,
  WrenchIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { CSSProperties } from "react";

/** `accent` (the default) is edge + tinted glyph; `tint` adds a background wash. */
export type RepoIdentityStyle = "accent" | "tint";

export type RepoMeta = {
  icon?: string;
  color?: string;
  style?: RepoIdentityStyle;
};

/** Keys are stable persisted ids (historically lucide component names); adding one
 * here is what makes it selectable. */
export const REPO_ICONS: Record<string, Icon> = {
  FolderGit2: GitBranchIcon,
  Rocket: RocketIcon,
  Bug: BugIcon,
  Boxes: CubeTransparentIcon,
  Terminal: TerminalIcon,
  Cloud: CloudIcon,
  Database: DatabaseIcon,
  Cpu: CpuIcon,
  Globe: GlobeIcon,
  BookOpen: BookOpenIcon,
  Wrench: WrenchIcon,
  FlaskConical: FlaskIcon,
  Palette: PaletteIcon,
  Zap: LightningIcon,
  Shield: ShieldIcon,
  Package: PackageIcon,
  Server: HardDrivesIcon,
  Code: CodeIcon,
  Layers: StackIcon,
  Sparkles: SparkleIcon,
  Hammer: HammerIcon,
  Radio: BroadcastIcon,
  Compass: CompassIcon,
  Bot: RobotIcon,
  Plane: AirplaneTiltIcon,
  Cog: GearIcon,
  Anchor: AnchorIcon,
  Brain: BrainIcon,
  Container: PackageIcon,
  Gauge: GaugeIcon,
  Leaf: LeafIcon,
  Puzzle: PuzzlePieceIcon,
};

export const DEFAULT_REPO_ICON: Icon = GitBranchIcon;

/** Mid-chroma for either surface, and clear of the reserved status hues — amber,
 * violet, sky-500 — so identity can't read as a signal. */
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

export function repoIcon(meta: RepoMeta | null | undefined): Icon {
  const name = meta?.icon;
  if (!name) return DEFAULT_REPO_ICON;
  return REPO_ICONS[name] ?? DEFAULT_REPO_ICON;
}

const HEX_RE = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Mirrors the Rust color parser: `#rgb` or `#rrggbb`, the `#` optional. */
export function isHexColor(s: string): boolean {
  return HEX_RE.test(s.trim());
}

export function normalizeHex(s: string): string | null {
  const raw = s.trim();
  if (!isHexColor(raw)) return null;
  const body = (raw.startsWith("#") ? raw.slice(1) : raw).toLowerCase();
  if (body.length === 3) {
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  }
  return `#${body}`;
}

/** All `undefined` for an unthemed repo, so a call site can spread them blind.
 * `edgeStyle` yields whenever a status accent owns the edge. */
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
  /** What the wash mixes into: a **sticky** surface must pass `"var(--card)"`. */
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

export function hasRepoColor(meta: RepoMeta | null | undefined): boolean {
  return meta?.color ? normalizeHex(meta.color) !== null : false;
}

/** A surface that *is* one repo wears the color whole, at the hashed wash's
 * alphas. `accent` can't withhold the fill here the way it does on a row. */
export function repoBandStyle(
  meta: RepoMeta | null | undefined,
  base = "transparent",
): CSSProperties | undefined {
  const hex = meta?.color ? normalizeHex(meta.color) : null;
  if (!hex) return undefined;
  return {
    backgroundColor: `color-mix(in srgb, ${hex} 10%, ${base})`,
    borderBottomColor: `color-mix(in srgb, ${hex} 40%, transparent)`,
  };
}
