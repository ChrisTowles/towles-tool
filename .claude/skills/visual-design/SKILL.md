---
name: visual-design
description: The Towles Tool desktop app's visual design language (apps/client), app-wide — color tokens, agent-status semantics, the identity wash (per-repo/checkout accent), folder/session hierarchy, spacing, glyphs, Tailwind recipes. Use when adding a new screen/component, restyling an existing one, or the user asks about the app's look, visual design, the rail, status dots/colors, the identity wash / repo colors, or the repo→folder→session hierarchy. Not needed for logic-only changes to already-styled components.
user-invocable: true
---

# Visual design — the app-wide language

Neutral grayscale Kumo base; hue is a budget spent on exactly three things:
**status**, **attention**, **identity**. Everything else is type, spacing, and
restraint. The full rendition — Agentboard anatomy (the named UI parts), live
specimens, token/recipe tables, the ΔE rationale — is
[visual-design.html](visual-design.html); read it before styling anything new.

## The rules that bite

- **Status dots mirror `statusColor()`** (`lib/agentboard.ts`) exactly; a new
  color implies a new state. Busy is cyan (never amber/yellow — that's the
  needs-you accent); background agents still out are not a state but a count
  beside the dot, a steady cyan-700 (`alertColor("background")`, also the
  rollup's bucket); interrupted is orange-800 (orange-500 sits inside both
  amber's and red's confusion radius). Before adding/tuning any hue, check
  OKLab ΔE by hand against every color it can sit next to; under ~15 between
  co-occurring colors is a real risk, not a nitpick.
- **Amber = needs-you, violet = agent-ness/focus.** A needs-you row gets the
  full treatment — `border-l-2 border-l-warn`, row-wide `bg-warn/10`
  (`/15` hover), flag dot beside the status dot; a thin border alone was
  tested and rejected. When a row is both active and needs-you, amber wins the
  border and fill; violet stays on the glyph.
- **Identity wash**: a surface that *is* one repo/checkout wears its accent as
  a /10 wash. **Every repo has a color** (`RepoData.color`, `lib/repo-identity.ts`):
  its pin, else one the backend deals like a chart series, so no two clash —
  never hash a repo's color client-side. **Identity whispers**: there is **one
  palette, `lib/colors.ts`** — repo colors, every chart series and legend
  swatch pull from it (Rust's `AUTO_PALETTE` is test-checked against it), and a
  data series never borrows a status hue. It is muted blues, slates and grayed
  plums only (12) — no red, pink, orange, **green (success)**, teal (reads as
  success), brown or saturated hue, nor a status hue — and a pin from outside
  it is ignored; the checkout accents (`identity-color.ts`) follow the
  same rule. A *checkout* (the app header) still
  takes its hashed `identityColor()`. Never mix keys on one surface. Absence is
  a state: an unwashed header *means* main checkout. Status and attention
  always render unchanged on top. **The rails barely wash**: a repo row (queue
  or tree) wears its color on icon and name (ink lifted toward the foreground,
  since the palette is muted) and a solid left edge; only a tree *repo header*
  adds a 6% wash, never the rows beneath. A repo pill is neutral until picked —
  with every row washed, color stops meaning anything and drowns the status it
  must never outrank.
- **A box is a control or an alert, never a fact.** Rail facts (diff counts,
  branch, base-moved) are bare `font-mono`; the box arrives on hover. Only
  needs-you, port drift, safe-to-delete and deleting keep a resting box. A
  pane header (one toolbar, room to spare) keeps the bordered, worded form.
- **Hierarchy:** repo → folder → session (`✦` agent / `❯` shell); attention
  bubbles up, and a deeper level never outranks its parent.
- **Type:** sans (Geist, 13px base) for chrome; `font-mono` for everything
  git/shell-owned — branches, ±diff stats, timestamps, counts, glyphs. Sizes
  come from the scale in `index.css` — `text-micro` (10px), `text-mini` (11px),
  `text-xs`, `text-caption` (13px) — never `text-[Npx]`; faces from
  `--font-sans`/`--font-mono`/`--font-terminal`.
- **Don't animate resting UI** — `animate-pulse` is only a live,
  currently-true nudge (the busy dot), never a passive fact or rollup.
- **Tokens only, one place to change them.** Neutrals are Kumo's
  (`bg-kumo-*`, `text-kumo-*`, `border-kumo-hairline`); every hue that means
  something is a signal token in `index.css`, named for its meaning —
  `danger`, `warn` (needs-you), `ok`, `agent` (violet), `merged`, `info`,
  `busy`/`busy-deep`/`busy-ink`, `waiting`, `paused`, `alert`, `spark`,
  `ident-a`/`ident-b`, `window-1…5` — each with its light and dark value. A
  component writes `text-danger`, `bg-warn/10`, never `text-red-600
  dark:text-red-400`; `lib/design-tokens.test.ts` fails on a raw Tailwind hue,
  a `text-[Npx]`, or a hex outside `lib/colors.ts`.

## Source of truth

`lib/agentboard.ts` (`statusColor()`) · `lib/identity-color.ts` (identity
wash) · `components/app-header.tsx` · the `agentboard-*` row files ·
`components/header-status.tsx` (needs-you math) · `src/index.css` (signal tokens, type scale, fonts) · `lib/colors.ts` (palette).
Behavior/flow rules (confirmations, error copy, settings) are the `ui-rules`
skill, not here.
