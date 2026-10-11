/** Per-repo identity. Every repo has a color — its pin (`meta.color`), else one
 * the backend deals it like a chart series — and an optional chosen icon. The
 * persisted `meta` blob is **untrusted**: an unknown icon degrades to the
 * default. This file is the one seam turning a hex into pixels. */
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

export type RepoMeta = {
  icon?: string;
  /** The pinned color; absent means the repo is dealt one. */
  color?: string;
};

/** What a repo looks like: its resolved color plus its chosen icon. */
export type RepoIdentity = { color: string; meta?: RepoMeta };

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

/** The swatches a repo can be pinned to — and dealt from: Rust's
 * `repo_meta::AUTO_PALETTE`, in the same order. Each clears the lightness,
 * chroma and contrast gates on both surfaces, and none is a reserved status
 * hue (amber, violet, sky), so identity can't read as a signal. */
export const REPO_PALETTE: readonly string[] = [
  "#3b82f6",
  "#e11d48",
  "#059669",
  "#d946ef",
  "#0891b2",
  "#65a30d",
  "#ec4899",
  "#0d9488",
  "#ef4444",
  "#2563eb",
  "#16a34a",
  "#c026d3",
  "#f43f5e",
  "#db2777",
  "#dc2626",
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

/** All `undefined` with no repo, so a call site can spread them blind.
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
  repo: RepoIdentity | undefined,
  /** What the wash mixes into: a **sticky** surface must pass `"var(--card)"`. */
  base = "transparent",
): RepoAccentStyles {
  const hex = repo ? normalizeHex(repo.color) : null;
  if (!hex) return EMPTY_ACCENT;
  return {
    iconStyle: { color: hex },
    edgeStyle: { borderLeftColor: `color-mix(in srgb, ${hex} 70%, transparent)` },
    surfaceStyle: { backgroundColor: `color-mix(in srgb, ${hex} 8%, ${base})` },
  };
}

/** A list row that belongs to one repo: tinted through, with a solid left edge
 * the width of the row's `border-l`. */
export function repoRowStyle(
  repo: RepoIdentity | undefined,
  base = "transparent",
): CSSProperties | undefined {
  const hex = repo ? normalizeHex(repo.color) : null;
  if (!hex) return undefined;
  return {
    backgroundColor: `color-mix(in srgb, ${hex} 12%, ${base})`,
    borderLeftColor: hex,
  };
}

/** A button that stands for one repo: its color as text and border, washed
 * through; `active` fills it, for the one whose form is open. */
export function repoChipStyle(
  repo: RepoIdentity | undefined,
  active: boolean,
): CSSProperties | undefined {
  const hex = repo ? normalizeHex(repo.color) : null;
  if (!hex) return undefined;
  return {
    color: active ? "white" : hex,
    backgroundColor: active ? hex : `color-mix(in srgb, ${hex} 14%, transparent)`,
    borderColor: `color-mix(in srgb, ${hex} ${active ? 100 : 45}%, transparent)`,
  };
}

/** A surface that *is* one repo wears the color whole, at the identity wash's
 * alphas. `accent` can't withhold the fill here the way it does on a row. */
export function repoBandStyle(
  repo: RepoIdentity | undefined,
  base = "transparent",
): CSSProperties | undefined {
  const hex = repo ? normalizeHex(repo.color) : null;
  if (!hex) return undefined;
  return {
    backgroundColor: `color-mix(in srgb, ${hex} 10%, ${base})`,
    borderBottomColor: `color-mix(in srgb, ${hex} 40%, transparent)`,
  };
}
