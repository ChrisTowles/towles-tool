---
name: visual-design
description: The Towles Tool desktop app's visual design language (apps/client), app-wide — color tokens, agent-status semantics, the identity wash (per-repo/checkout accent), folder/session hierarchy, spacing, glyphs, Tailwind recipes. Use when adding a new screen/component, restyling an existing one, or the user asks about the app's look, visual design, the rail, status dots/colors, the identity wash / repo colors, or the repo→folder→session hierarchy. Not needed for logic-only changes to already-styled components.
user-invocable: true
---

# Visual design — the app-wide language

Neutral grayscale shadcn base; hue is a budget spent on exactly three things:
**status**, **attention**, **identity**. Everything else is type, spacing, and
restraint. The full rendition — Agentboard anatomy (the named UI parts), live
specimens, token/recipe tables, the ΔE rationale — is
[visual-design.html](visual-design.html); read it before styling anything new.

## The rules that bite

- **Status dots mirror `statusColor()`** (`lib/agentboard.ts`) exactly; a new
  color implies a new state. Busy is cyan (never amber/yellow — that's the
  needs-you accent); interrupted is orange-800 (orange-500 sits inside both
  amber's and red's confusion radius). Before adding/tuning any hue, check
  OKLab ΔE by hand against every color it can sit next to; under ~15 between
  co-occurring colors is a real risk, not a nitpick.
- **Amber = needs-you, violet = agent-ness/focus.** A needs-you row gets the
  full treatment — `border-l-2 border-l-amber-500`, row-wide `bg-amber-500/10`
  (`/15` hover), flag dot beside the status dot; a thin border alone was
  tested and rejected. When a row is both active and needs-you, amber wins the
  border and fill; violet stays on the glyph.
- **Identity wash** (`identityColor()`, `lib/identity-color.ts`): a surface
  that *is* one repo/checkout wears its hashed accent as a /10 wash. Key by
  what the surface identifies — checkout for the app header, repo for the
  working-context band — and never mix keys on one surface. Absence is a
  state: an unwashed header *means* main checkout. Status and attention always
  render unchanged on top.
- **A box is a control or an alert, never a fact.** Rail facts (diff counts,
  branch, base-moved) are bare `font-mono`; the box arrives on hover. Only
  needs-you, port drift, safe-to-delete and deleting keep a resting box. A
  pane header (one toolbar, room to spare) keeps the bordered, worded form.
- **Hierarchy:** repo → folder → session (`✦` agent / `❯` shell); attention
  bubbles up, and a deeper level never outranks its parent.
- **Type:** sans (Geist, 13px base) for chrome; `font-mono` for everything
  git/shell-owned — branches, ±diff stats, timestamps, counts, glyphs.
- **Don't animate resting UI** — `animate-pulse` is only a live,
  currently-true nudge (the busy dot), never a passive fact or rollup.
- **Tailwind + shadcn tokens only** — no raw colors, no hand-written CSS, so
  light and dark both work.

## Source of truth

`lib/agentboard.ts` (`statusColor()`) · `lib/identity-color.ts` (identity
wash) · `components/app-header.tsx` · the `agentboard-*` row files ·
`components/header-status.tsx` (needs-you math) · `src/index.css` (tokens).
Behavior/flow rules (confirmations, error copy, settings) are the `ui-rules`
skill, not here.
