/** The app's one categorical palette: every repo color, chart series and legend
 * swatch pulls from here, so a hue means the same thing on every screen. Rust's
 * `repo_meta::AUTO_PALETTE` deals repos from the same list in the same order,
 * and a test there reads this file to keep the two in step.
 *
 * Identity is not a signal, so it whispers: muted blues, slates and grayed
 * plums only — nothing red, pink, orange, green or teal (both read as success),
 * brown or saturated, and no status hue (amber, violet, cyan, sky). */
export const PALETTE: readonly string[] = [
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

/** A series that is no one in particular — "Other", an uncommon tool. Dark
 * enough to stay clear of the palette's slates. */
export const NEUTRAL = "#4b5059";

/** The `i`th series' color, cycling past the end. */
export function paletteAt(i: number): string {
  return PALETTE[i % PALETTE.length];
}
