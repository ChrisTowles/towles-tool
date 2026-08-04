//! Which lines a run may judge.
//!
//! The default judges only the lines a branch adds, because a repo-wide list is
//! a backlog and a gate that fails every run is one nobody reads. The base tree
//! is compared against the **working tree**, not against `HEAD`, so a local run
//! judges what is about to be pushed rather than only what is committed.
//!
//! The `--new-from-*` flag names are golangci-lint's, which is where the idea is
//! best known from.

use std::path::Path;

use crate::CommentBudgetError;

/// The branch a run compares against unless told otherwise.
pub const DEFAULT_BASE: &str = "main";

/// The whole of any file: what a new file adds, and what `whole_files` widens
/// every touched file to.
const ALL: (usize, usize) = (1, usize::MAX);

/// Matches what a git UI would show added.
const DIFF_ALGORITHM: gix::diff::blob::Algorithm = gix::diff::blob::Algorithm::Myers;

/// What a run compares against. Merge-base is the PR question — "what did this
/// branch add" — and survives the base branch moving underneath it; a plain rev
/// is for `HEAD~1` and other hand-picked comparisons.
#[derive(Debug, Clone)]
pub enum Since {
    MergeBase(String),
    Rev(String),
}

impl Since {
    pub fn describe(&self, whole_files: bool) -> String {
        let what = if whole_files { "whole files touched" } else { "lines added" };
        match self {
            Since::MergeBase(r) => format!("scope: {what} since the merge-base with `{r}`"),
            Since::Rev(r) => format!("scope: {what} since `{r}`"),
        }
    }
}

/// Keeps decoded objects in memory, which is what makes the per-file lookup in
/// [`Diff::blob`] affordable: every path re-walks the base tree and the
/// directories above it, so without this each one is inflated out of the pack
/// again for every file under it. Sized for a source tree's directories rather
/// than its contents — base blobs are read once each and only pass through,
/// while the trees above them are touched by every lookup, so they stay hot.
const OBJECT_CACHE_BYTES: usize = 4 * 1024 * 1024;

/// Asks per file rather than enumerating a diff up front. That is what lets the
/// comparison span committed and uncommitted work alike, and it makes an
/// untracked file fall out as "every line added" for free.
pub struct Diff {
    repo: gix::Repository,
    tree: gix::ObjectId,
    pub whole_files: bool,
}

impl Diff {
    pub fn open(root: &Path, since: &Since, whole_files: bool) -> Result<Self, CommentBudgetError> {
        let mut repo = gix::open(root)
            .map_err(|e| CommentBudgetError::Git(format!("open repository: {e}")))?;
        repo.object_cache_size(OBJECT_CACHE_BYTES);
        // A CI checkout is detached with no local branch refs, so the base a PR
        // names only ever exists as the remote one.
        let rev = |spec: &str| {
            repo.rev_parse_single(spec)
                .or_else(|_| repo.rev_parse_single(format!("origin/{spec}").as_str()))
                .map(|id| id.detach())
                .map_err(|_| {
                    CommentBudgetError::Git(format!(
                        "no such revision `{spec}` (nor `origin/{spec}`)"
                    ))
                })
        };
        let id = match since {
            Since::Rev(r) => rev(r)?,
            Since::MergeBase(r) => {
                let head = rev("HEAD")?;
                repo.merge_base(rev(r)?, head)
                    .map_err(|e| CommentBudgetError::Git(format!("no merge-base with `{r}`: {e}")))?
                    .detach()
            }
        };
        let tree = repo
            .find_object(id)
            .map_err(|e| CommentBudgetError::Git(format!("read base commit: {e}")))?
            .peel_to_tree()
            .map_err(|e| CommentBudgetError::Git(format!("read base tree: {e}")))?
            .id;
        Ok(Diff { repo, tree, whole_files })
    }

    /// The 1-based inclusive line ranges `content` adds over the base, or `None`
    /// when this file is out of scope — unchanged, or changed only by deletions,
    /// which add no line to judge.
    pub fn scope_of(&self, rel: &str, content: &str) -> Option<Vec<(usize, usize)>> {
        let before = self.blob(rel);
        let after = content.as_bytes();
        if before.as_deref() == Some(after) {
            return None;
        }
        let Some(before) = before.filter(|_| !self.whole_files) else {
            return Some(vec![ALL]);
        };
        let input = gix::diff::blob::InternedInput::new(before.as_slice(), after);
        let diff = gix::diff::blob::diff_with_slider_heuristics(DIFF_ALGORITHM, &input);
        // `Hunk::after` is a half-open range of 0-based line indices on the new
        // side, so its exclusive end is already the 1-based inclusive last line.
        let ranges: Vec<(usize, usize)> = diff
            .hunks()
            .filter(|h| !h.after.is_empty())
            .map(|h| (h.after.start as usize + 1, h.after.end as usize))
            .collect();
        (!ranges.is_empty()).then_some(ranges)
    }

    /// Resolves the base tree per call rather than holding a `gix::Tree`, which
    /// borrows the repository and so cannot be stored beside it. That costs
    /// nothing beyond the first file thanks to [`OBJECT_CACHE_BYTES`].
    fn blob(&self, rel: &str) -> Option<Vec<u8>> {
        let tree = self.repo.find_object(self.tree).ok()?.peel_to_tree().ok()?;
        let entry = tree.lookup_entry_by_path(rel).ok().flatten()?;
        entry.object().ok()?.try_into_blob().ok().map(|blob| blob.data.clone())
    }
}

/// Whether a 1-based line is one this run may judge. `None` ranges mean the
/// whole file, which is what a run with no base measures.
pub fn in_scope(ranges: Option<&[(usize, usize)]>, line: usize) -> bool {
    ranges.is_none_or(|rs| rs.iter().any(|&(a, b)| line >= a && line <= b))
}
