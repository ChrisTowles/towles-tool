# The Agentboard rail, and how things animate

Two `apps/client` areas whose rules only matter once you are inside them — split
out of [`apps/client/CLAUDE.md`](../apps/client/CLAUDE.md), which every session
pays for, and which keeps the conventions that apply everywhere.

## The rail is five files, split by what a row *is*

`components/agentboard-rail.tsx` is the rail's own chrome (collapsed strip,
rollup tally) — not the tree, which is `agentboard-repo-group` (a repo) →
`agentboard-folder-header` (a checkout) → `agentboard-session-row` (a PTY) /
`agentboard-pane-rows`, with shared atoms in `agentboard-bits` and pure logic in
`lib/agentboard.ts`. A new row kind gets a sixth file, not a grown one.

**In a rail row, a box means a control or an alert — never a fact**, because a
rail that boxes everything ranks nothing. Facts (diff counts, branch, base-moved,
pane buttons) are bare mono type (`CHIP_CLASS`) with the box arriving on hover;
only needs-you, port drift, safe-to-delete and deleting keep a resting box. A
pane *header* is the opposite case and keeps the bordered `labeled` form. The
rest of the look lives in the `visual-design` skill.

A folder row is **one line when the rail is wide enough, two when it isn't** —
`@container/row` at 34rem, an `order` swap keeping the toolbar on the name's line
while git counts drop below. Container, not viewport: the rail is independently
resizable, so the question is *this row's* room.

## Two animation idioms — the choice is mechanical, not stylistic

`tw-animate-css` is the default: the vendored `components/ui/*` animate with
`data-open:animate-in fade-in-0 …`, which works because Radix keeps a closing
element mounted until its animation ends.

Nothing else has that luxury. The rail renders a backend snapshot, so a removed
row is simply absent from the next payload and React unmounts it before any CSS
can run. That case uses `motion`: `<AnimatePresence>` holds the departed row on
screen and `layout` slides the survivors in, configured from
`lib/rail-motion.ts` — spread it rather than hand-rolling per-row variants.

Deliberately **not** yaak's `<LazyMotion strict>` + `m.*`, which splits motion
into its own chunk only when every `AnimatePresence` consumer is lazily imported
— screens here are static imports (`screens/index.tsx`), so a build puts motion
in the initial chunk regardless. `main.tsx` keeps only
`<MotionConfig reducedMotion="user">`, which is real app-wide a11y policy.
