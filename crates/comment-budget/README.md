# comment-budget

A budget for comment volume, written for a codebase an AI writes most of.

A model can emit more commentary in one pass than a human could ever accurately
review, and it keeps adding — narrating each step, restating the line below it,
heading every block, layering the next pass over the last — until there is too
much of it to read. Commentary nobody reads is not documentation; it is what
the code is hiding behind.

So the budget is a cap on what review can actually absorb. One question:
**how much commentary must a reader wade through to reach the code?**

```
comment_lines / (comment_lines + code_lines)      blank lines ignored
```

So `0.15` means "1 line in 7 is comment" — not comments-per-code-line. Two other
signals sit beside the ratio: an over-long unbroken *run* of comment, and an
over-long `.md`. It never reads what a comment *says*, so it can't tell you one
is stale or wrong — that is not the check. Volume is, and nothing else measures
it.

## Install

```sh
cargo install comment-budget                   # or, for a prebuilt binary:
bun add -d @towles-tool/comment-budget         # npm/pnpm/yarn work too
```

## Use

```sh
comment-budget                    # the gate: only the lines this branch adds over `main`
comment-budget --all              # the standing backlog, repo-wide
comment-budget --report           # thresholds in effect, surface table, worst files
comment-budget --format json      # findings as an array, for CI to consume
comment-budget --surface web      # one surface, for a session spent fixing it

comment-budget --new-from-merge-base release   # gate against a branch other than main
comment-budget --new-from-rev HEAD~3           # gate against a revision itself

comment-budget init               # write a starter config, budgets seeded from this tree
```

Exit status is `0` when nothing errored, `1` when something did, `2` on a bad
invocation. Warnings never fail the run — they are the standing hit list.

### Why the default is a diff

Repo-wide, an established codebase reports hundreds of errors, and a gate that
fails every run is one nobody reads. So the default judges only what a branch
*adds*, and the ratio is the added lines' own — a branch can neither add
commentary nor inherit the file's existing debt. An over-long run is the
exception: it is measured whole and merely has to touch an added line to be
reported, because a reader wades through all of it however much you wrote.

The comparison is against the **working tree**, so a local run judges what you
are about to push, not only what you have committed. `--whole-files` opts back
into judging every touched file whole. The `--new-from-*` flag names are
golangci-lint's, which is where the idea is best known from.

## Configure

Everything measured — and how hard, and why — lives in `comment-budget.toml` at
the root of the tree, found by searching upward from the working directory.

- **kinds** bind file extensions to a grammar — `rust`, `typescript`, `tsx`,
  `hcl`, or `prose`. `exempt` prefixes are invisible to every signal, neither
  comment nor code, so a Rust `//!` header can hold the decision it records —
  but only for a file's first `exempt_free` lines, past which they count
  normally. That cap is what stops `exempt` being a hiding place: without it the
  cheapest way to pass is to move prose from `///` into `//!`, shortening
  nothing for a reader. `counted` is the bloat being measured; a comment
  matching neither list counts, so a new syntax can't slip through unmeasured.
- **surfaces** claim paths by glob and set the thresholds. First match wins, and
  a readable file no surface claims is a hard **error** — under first-match-wins
  the failure mode of this design is a tree nobody noticed was exempt, and that
  reads exactly like passing. A glob that claims no files (matching nothing, or
  shadowed by an earlier surface) is a standing **warning** for the same reason.
- Every threshold is a line count, one `{ warn, error }` pair per signal:
  `surface.ratio` for comment lines past the file's budget, `surface.run` for an
  unbroken comment block, `surface.length` for a prose file's total lines. The
  report measures each surface against its budget.
- `surface.ratio` gates a file's **overshoot**: its comment lines beyond what
  `budget` allows for its size. Mass and density gate together by construction —
  a tiny stub can't be far over budget, a big lightly-commented file never is —
  and the number is the one the fix is measured in: lines to delete.

A file may opt out with a top-of-file `comment-budget: allow(<reason>)`. The
reason is required — an unexplained opt-out is the failure mode it exists to
prevent. `comment-budget init` writes a starter config with each budget seeded
at the tree's own 75th percentile. A minimal config:

```toml
skip = ["node_modules", "target", "dist"]

[kinds.rust]
grammar     = "rust"              # the tree-sitter grammar whose comment nodes are read
extensions  = ["rs"]
exempt      = ["//!"]             # module docs: where hard-won "why" lives
exempt_free = 12                  # ...but only this many lines of it are free
counted     = ["///", "//"]       # item docs and narration: the bloat being measured

[kinds.markdown]
grammar    = "prose"              # parses nothing; measures length instead
extensions = ["md"]

[[surface]]
name   = "crates"
paths  = ["crates/*/src/**/*.rs"]
goal   = "Document the module and the crossing points; not every pub item."
[surface.ratio]
budget = 0.15                     # comments may be 15% of a file, free
warn   = 20                       # warn at 20 comment lines past that
error  = 60
[surface.run]
warn  = 8
error = 14

[[surface]]
name   = "docs"
paths  = ["**/*.md"]
goal   = "Prose has no code to sit against, so length is the only signal it offers."
[surface.length]
warn  = 150
error = 250

[escape]
directive = "comment-budget: allow(<reason>)"
```

## Library

The binary is a thin shell over the crate; `Finding` keeps its fields rather
than only a rendered line, so a consumer can emit GitHub annotations or editor
diagnostics without parsing text back out.

```rust
let (cfg, root) = Config::discover(&std::env::current_dir()?)?;
let diff = Diff::open(&root, &Since::MergeBase("main".into()), false)?;
let analysis = comment_budget::analyze(&root, &cfg, Some(&diff))?;
for finding in comment_budget::judge(&cfg, &analysis.stats) {
    println!("{finding}");
}
```

## Fixing what it reports

Delete, don't reflow. Cut history — git already holds it — and keep only what
looks forward: the *why*, and the *how* where the code leaves it unclear.
Squeezing under a threshold just moves an error onto the warning list, and the
budgets are not the thing to lower.

## License

MIT OR Apache-2.0, at your option.
