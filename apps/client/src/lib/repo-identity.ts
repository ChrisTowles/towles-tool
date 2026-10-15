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

/** The only colors a repo can be pinned to — and dealt from: Rust's
 * `repo_meta::AUTO_PALETTE`, in the same order. Identity is not a signal, so it
 * whispers: muted blues, slates and grayed plums only — nothing red, pink, orange, green
 * or teal (both read as success), brown or saturated, and no status hue (amber, violet, cyan, sky). */
export const REPO_PALETTE: readonly string[] = [
  "#718dba",
  "#818e9b",
  "#536992",
  "#787ca7",
  "#567786",
  "#8a697b",
  "#b08c9f",
  "#9d7a8d",
  "#6f7192",
  "#9b95a2",
  "#8d7f9f",
  "#78717d",
];

/** `color` when it is a palette swatch; a pin from anywhere else isn't kept. */
export function paletteColor(color: string | undefined): string | undefined {
  const hex = color ? normalizeHex(color) : null;
  return hex && REPO_PALETTE.includes(hex) ? hex : undefined;
}

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
 * `edgeStyle` yields whenever a status accent owns the edge. `headerStyle` is a
 * rail repo header's edge plus a `--repo-wash` for its `bg-(--repo-wash)`, a
 * variable so `hover:` still wins over it. */
export type RepoAccentStyles = {
  iconStyle: CSSProperties | undefined;
  edgeStyle: CSSProperties | undefined;
  surfaceStyle: CSSProperties | undefined;
  headerStyle: CSSProperties | undefined;
};

const EMPTY_ACCENT: RepoAccentStyles = {
  iconStyle: undefined,
  edgeStyle: undefined,
  surfaceStyle: undefined,
  headerStyle: undefined,
};

export function repoAccentStyles(
  repo: RepoIdentity | undefined,
  /** What the wash mixes into: a **sticky** surface must pass `"var(--card)"`. */
  base = "transparent",
): RepoAccentStyles {
  const hex = repo ? normalizeHex(repo.color) : null;
  if (!hex) return EMPTY_ACCENT;
  // The palette is muted, so the edge is drawn solid — loud in placement, not hue.
  const edgeStyle = { borderLeftColor: hex };
  return {
    iconStyle: { color: repoInk(hex) },
    edgeStyle,
    surfaceStyle: { backgroundColor: `color-mix(in srgb, ${hex} 6%, ${base})` },
    headerStyle: {
      ...edgeStyle,
      "--repo-wash": `color-mix(in srgb, ${hex} 6%, var(--card))`,
    } as CSSProperties,
  };
}

/** A repo color as text: muted, so lifted toward the foreground to read on
 * either surface. */
function repoInk(hex: string): string {
  return `color-mix(in oklab, ${hex} 88%, var(--foreground))`;
}

/** A button that stands for one repo and is picked: its color as text and
 * border, washed through. */
export function repoChipStyle(repo: RepoIdentity | undefined): CSSProperties | undefined {
  const hex = repo ? normalizeHex(repo.color) : null;
  if (!hex) return undefined;
  return {
    color: repoInk(hex),
    backgroundColor: `color-mix(in srgb, ${hex} 14%, transparent)`,
    borderColor: hex,
  };
}

/** A surface that *is* one repo wears the rail header's treatment: a solid
 * left edge (the caller sets its width), a 6% wash, and `ink` for its name.
 * `accent` can't withhold the fill here the way it does on a row. */
export function repoBandStyle(
  repo: RepoIdentity | undefined,
  base = "transparent",
): { band: CSSProperties; ink: CSSProperties } | undefined {
  const hex = repo ? normalizeHex(repo.color) : null;
  if (!hex) return undefined;
  return {
    band: { backgroundColor: `color-mix(in srgb, ${hex} 6%, ${base})`, borderLeftColor: hex },
    ink: { color: repoInk(hex) },
  };
}
