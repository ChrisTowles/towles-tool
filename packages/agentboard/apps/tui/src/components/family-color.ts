import type { Theme } from "@tt-agentboard/runtime";

const KNOWN_FAMILIES = new Map<string, keyof Theme["palette"]>([
  ["blog", "pink"],
  ["dotfiles", "peach"],
  ["f", "teal"],
  ["toolbox", "sky"],
  ["towles-tool", "lavender"],
]);

const FALLBACK_HUES: Array<keyof Theme["palette"]> = ["mauve", "blue", "green", "yellow", "red"];

const SLOT_SUFFIX = /-(?:primary|slot-\d+)$/;

export function familyOf(sessionName: string): string {
  const stripped = sessionName.replace(SLOT_SUFFIX, "");
  return stripped || sessionName;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function familyColor(sessionName: string, palette: Theme["palette"]): string {
  const family = familyOf(sessionName);
  const known = KNOWN_FAMILIES.get(family);
  if (known) return palette[known] as string;
  const key = FALLBACK_HUES[hash(family) % FALLBACK_HUES.length]!;
  return palette[key] as string;
}
