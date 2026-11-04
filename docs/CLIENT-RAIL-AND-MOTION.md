# The Agent Board rails, and how things animate

Two `apps/client` areas whose rules only matter once you are inside them — split
out of [`apps/client/CLAUDE.md`](../apps/client/CLAUDE.md), which every session
pays for, and which keeps the conventions that apply everywhere.

## Two rails over one workspace

`screens/agentboard.tsx` is one screen with two rails, picked by the Tree/Queue
tabs atop it (`railView` in `useWorkspace`, persisted; `Mod+Shift+T` flips it);
only the rail's contents swap, so the panes never remount. On Queue,
`components/queue-rail.tsx` is the rail: one strip of repo pills (filter, `+` new task), then the queue's lanes. Every
row is a board task that owns one of the board's checkouts; a checkout no task
owns is on the tree only, until its "adopt" chip makes it a task. On Tree the
checkout tree below *is* the rail, and `lib/rail-nodes.ts` is the one walk its
cursor, jump digits and fold chords read.

## The checkout tree is eight files, split by what a row *is*

`components/agentboard-rail.tsx` is the rail's own chrome (collapsed strip,
rollup tally) — not the tree, which is `agentboard-repo-group` (a repo, in a
left column) → `agentboard-checkout-line` (a checkout, one line), or
`agentboard-home-header` (`~`) → `agentboard-session-chip` (a PTY, inline on its
line) / `agentboard-pane-chips`, plus `agentboard-fold-rows` for the rows that stand for
rows *not* shown ("N idle", "N unmanaged") and `agentboard-archived-rows` for
the archived repos beneath the tree, with shared atoms in
`components/agentboard-bits/` and pure logic in `lib/agentboard/`. A new row kind gets a
ninth file, not a grown one.

**Order is Rust's, archive is a flag.** `tt_agentboard::rail_sort` sorts the
payload by `agentboard.railRepoSort`/`railTaskSort` (set through
`ab_set_rail_sort`), so nothing client-side re-sorts. An archived repo
(`archivedPaths` in `repos.json`) still arrives, flagged `archived`;
`partitionArchived` takes it off the rail before every other filter, and the
"N archived" row is the only way back to it.

**`~` is always the first group.** The engine appends one `home`-origin row
for the home directory (a tracked `~` repo replaces it), and the longest-prefix
resolve sends any app-launched agent whose cwd no repo claims there. It is no
repo: git is never read for it, the idle filter never folds it, and it is kept
out of the queue's repo pills and the new-repo parent dirs.

**Folding is per-repo, and always reversible in place.** The rail filter demotes
idle checkouts; `isFolderUnmanaged` demotes the worktrees agents make for
themselves, whatever the filter says. Both leave a counted stub row that peeks
open (`withoutFolded` is the one answer for the render and for
`lib/rail-nodes.ts`'s walk, so the keyboard sees exactly what you see), and
neither ever folds a checkout you are working in, one with a live session, or
one with something waiting on you.

**In a rail row, a box means a control or an alert — never a fact**, because a
rail that boxes everything ranks nothing. Facts (diff counts, branch, base-moved,
pane buttons) are bare mono type (`CHIP_CLASS`) with the box arriving on hover;
only needs-you, port drift, safe-to-delete, discard, delete-blocked and deleting
keep a resting box. **Hover never reveals a verb**: a line's actions are the
worded `LineActionBar` on the selected checkout plus an always-visible ⋯, and
anything that explains itself carries `data-hud` for the rail's status line
(`screens/agentboard/rail-hud.tsx`) instead of a tooltip. A
pane *header* is the opposite case and keeps the bordered `labeled` form. The
rest of the look lives in the `visual-design` skill.

**Built for a wide rail, degrading by container.** At 34rem a repo's name is a
sticky left column beside its checkout lines (`@container/repo`); narrower, it
stacks back into a header row. A checkout line is name | session chips | facts
from 24rem (`@container/line`); narrower, its chips wrap onto a second line.
Checkout lines never fold — their sessions *are* the line — so only repos
collapse. Branch, PR, base and spend are not on the line at all: they are the
task header's labeled facts (`agentboard-working-context`), along with model,
cache and context in the pane chrome. Container, not viewport: the rail is
independently resizable.

## Two animation idioms — the choice is mechanical, not stylistic

`tw-animate-css` is the default: the vendored `components/ui/*` animate with
`data-open:animate-in fade-in-0 …`, and Kumo's overlays animate themselves; both
work because their Base UI primitives keep a closing element mounted
until its animation ends.

Nothing else has that luxury. The rail renders a backend snapshot, so a removed
row is simply absent from the next payload and React unmounts it before any CSS
can run. That case uses `motion`: `<AnimatePresence>` holds the departed row on
screen while it collapses, and its neighbours reflow with the height, configured
from `lib/rail-motion.ts` — spread it rather than hand-rolling per-row variants.
**No `layout` on rail rows**: the rails re-render every tick and nest presence
lists three deep, and projection on top of a height reflow moves rows twice. The
queue rail is the one exception, with slower fades of its own in
`queue-rail.tsx`, the arrival waiting out the departure: its rows move on
agents' schedule rather than yours, so motion there has to stay below the
threshold of pulling your eye.

Deliberately **not** yaak's `<LazyMotion strict>` + `m.*`, which splits motion
into its own chunk only when every `AnimatePresence` consumer is lazily imported
— screens here are static imports (`screens/index.tsx`), so a build puts motion
in the initial chunk regardless. `main.tsx` keeps only
`<MotionConfig reducedMotion="user">`, which is real app-wide a11y policy.
