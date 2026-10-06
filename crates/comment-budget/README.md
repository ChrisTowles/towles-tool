# comment-budget

A ratchet on comment volume, written for a codebase an AI writes most of.

A model can emit more commentary in one pass than a human could ever review,
and it keeps adding — narrating each step, restating the line below it, layering
the next pass over the last — until there is too much of it to read. This puts a
stop to the *growth*. It never reads what a comment says, so it can't tell you
one is stale or wrong; it measures how much there is, and nothing else does.

There is no config file. The whole policy is four numbers.

## The rule

For every file a change touches, compared with the same file at the merge-base:

- **Growth.** A file's *excess* is its comment lines beyond a **15%** share of
  its non-blank lines. The change fails if it grew that excess by **5** lines or
  more **and** the file ends more than **10** over.
- **Walls.** The change fails if it adds an unbroken comment block of **13**
  lines or more, or grows a block that was already 13+ by **5** lines or more.
  A block that was shorter than 13 fails as soon as it reaches 13. Rewording or
  shrinking an old block is fine.

A file the base does not have starts from an excess of 0. A file that only moved
is unchanged. Old debt never fails a change; only adding to it does.

Every comment syntax counts — `//`, `///`, `//!`, `/* */`, `#` — wherever it
starts a line. A trailing comment after code is code; blank lines are neither.

The language comes from the file extension: Rust (`.rs`), TypeScript and
JavaScript (`.ts .mts .cts .js .mjs .cjs`), TSX/JSX (`.tsx .jsx`), and HCL
(`.tf .tfvars .hcl`). Other files are not judged, Markdown included.

## What is judged

Tracked and untracked files in the work tree, minus anything `.gitignore`
excludes and anything `.gitattributes` marks `linguist-generated` or
`linguist-vendored`:

```gitattributes
src/components/ui/** linguist-vendored
src/bindings.ts      linguist-generated
```

Nested repositories, such as worktrees inside the checkout, are skipped.

## The escape

One, per file, in its header (the lines before the first blank one):

```rust
//! comment-budget: allow(every `///` here is `--help` text clap prints)
```

The reason is mandatory. `allow()` with no reason fails.

## Install

```sh
cargo install comment-budget                   # or, for a prebuilt binary:
bun add -d @towles-tool/comment-budget         # npm/pnpm/yarn work too
uvx comment-budget                             # `uv tool install`, pipx and pip work too
```

As a [pre-commit](https://pre-commit.com) hook, the PyPI package is the whole
install:

```yaml
repos:
  - repo: local
    hooks:
      - id: comment-budget
        name: comment-budget
        language: python
        additional_dependencies: [comment-budget]
        entry: comment-budget
        pass_filenames: false     # it reads the branch's diff itself
```

## Use

```sh
comment-budget              # the gate: what changed since the merge-base with the base
comment-budget release      # the same, against another base
comment-budget --all        # every file judged as if new: the repo-wide backlog
```

The base defaults to `$GITHUB_BASE_REF`, which GitHub Actions sets on
`pull_request` runs, and otherwise to `main`; `origin/<base>` is tried when no
local branch has the name. The comparison includes uncommitted and untracked
work, so a local run judges what you are about to push. In GitHub Actions, check
out with `fetch-depth: 0` so the merge-base exists:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- run: npx @towles-tool/comment-budget
```

Exit status is `0` when nothing failed, `1` when something did, `2` on a bad
invocation or an unreadable repository.

## Migrating from 0.x

1.0 is a hard cutover with nothing kept for compatibility.

- **Delete `comment-budget.toml`.** It is not read. Kinds, surfaces, budgets,
  tiers, `skip`, `exempt` and `exempt_free` are all gone: one budget, one floor,
  one growth step and one run length apply everywhere.
- **Move `skip` entries to `.gitattributes`** as `linguist-vendored` or
  `linguist-generated`. Paths already in `.gitignore` need nothing.
- **`//!` and every other exempt syntax now counts.** No baseline is needed for
  that: the ratchet only fails a change that grows a file's excess.
- **Flags:** `--new-from-merge-base <ref>` is now the bare `<ref>` argument;
  `--new-from-rev`, `--whole-files`, `--report`, `--surface`, `--format`,
  `--root`, `--config` and `init` are gone. Run it from inside the repository.
- **Warnings are gone.** Everything it reports fails the run.
- **Markdown is no longer measured.**
- **The library API is gone.** The crate is a binary only.
- **`comment-budget: allow(<reason>)` is unchanged.**

## Fixing what it reports

Delete, don't reflow. Cut history, since git already holds it, and keep only
what looks forward: the *why*, and the *how* where the code leaves it unclear.

## License

MIT OR Apache-2.0, at your option.
