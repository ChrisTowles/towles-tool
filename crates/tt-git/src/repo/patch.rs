//! Patch identity — "does the base branch already contain this change?"
//!
//! This is the in-process replacement for `git cherry`, and it removes the
//! ugliest shell-out in the workspace along with it. Asking `git cherry`
//! whether a *squashed* branch had landed meant synthesising a commit for its
//! cumulative tree — which meant `commit-tree` writing a real object into the
//! repository, then deleting the loose object again so the Agentboard poll did
//! not litter thousands of dead objects a day. In process there is no object to
//! write: a patch id is computed from trees that already exist and thrown away.
//!
//! ## These ids are not git's
//!
//! `git patch-id` has a specific, stable-across-versions hash. This does not
//! reproduce it, and does not try to. A patch id here is only ever compared
//! against another id produced by this same code, in the same process, over the
//! same repository — nothing is persisted, exchanged, or shown to a user. What
//! the comparison requires is that identical changes hash identically and
//! different ones (almost certainly) do not, which is a far weaker contract
//! than byte-compatibility with git, and one this can meet without
//! reimplementing git's diff formatting.
//!
//! What *is* preserved from git's definition is what a patch id ignores:
//! commit metadata, parentage, and the line numbers a hunk lands on. Two
//! commits with the same content change are the same patch whether they were
//! rebased, cherry-picked, or committed a year apart.

use std::collections::HashSet;

use super::{Repo, Result};

/// The identity of a change, independent of where or when it was committed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PatchId(gix::ObjectId);

impl std::fmt::Display for PatchId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// Ceiling on how many of the base branch's commits are hashed when building
/// the set to compare against.
///
/// A busy `main` can hold thousands of commits since a task's merge-base, and
/// every one costs a tree diff. The cap bounds that, and it is safe in one
/// direction only — which is the direction that matters: a truncated set can
/// only *fail* to recognize that something landed, never invent a match. The
/// failure mode is a merged task reported as still holding work, i.e. a task
/// that does not get cleaned up. The opposite error would be deleting work.
const MAX_BASE_PATCHES: usize = 4096;

impl Repo {
    /// The patch id of a commit: its change against its first parent. `None`
    /// for an unreadable commit; a root commit hashes as the addition of its
    /// whole tree.
    pub fn patch_id_of_commit(&self, id: gix::ObjectId) -> Option<PatchId> {
        let commit = self.inner().find_object(id).ok()?.try_into_commit().ok()?;
        let tree = commit.tree().ok()?;
        let parent = commit.parent_ids().next().and_then(|p| self.tree_at(p.detach()));
        self.patch_id_between(parent.as_ref(), &tree)
    }

    /// The patch id of the *cumulative* change between two revisions — what a
    /// squash merge collapses a branch into. This is the probe that recognizes
    /// a squash-merged branch: its whole diff since the merge-base, as one
    /// patch, is what landed on the base under a brand new sha.
    pub fn cumulative_patch_id(&self, from: gix::ObjectId, to: gix::ObjectId) -> Option<PatchId> {
        let old = self.tree_at(from)?;
        let new = self.tree_at(to)?;
        self.patch_id_between(Some(&old), &new)
    }

    /// Patch ids of every commit the base branch gained since `boundary`, for
    /// membership tests. See [`MAX_BASE_PATCHES`] for the bound and why
    /// exceeding it is safe.
    pub fn base_patch_ids(
        &self,
        boundary: gix::ObjectId,
        base_tip: gix::ObjectId,
    ) -> HashSet<PatchId> {
        let mut out = HashSet::new();
        let Ok(commits) = self.rev_list(boundary, base_tip) else {
            return out;
        };
        for id in commits.into_iter().take(MAX_BASE_PATCHES) {
            if let Some(patch) = self.patch_id_of_commit(id) {
                out.insert(patch);
            }
        }
        out
    }

    /// `git cherry <base> <branch>`: each commit the branch added since the
    /// merge-base, newest first, paired with whether the base already holds an
    /// identical change.
    ///
    /// Empty when the two share no history or the branch added nothing.
    pub fn cherry(&self, base: &str, branch: &str) -> Result<Vec<(gix::ObjectId, bool)>> {
        let (Some(base_id), Some(branch_id)) = (self.resolve(base), self.resolve(branch)) else {
            return Ok(Vec::new());
        };
        let Some(boundary) = self.merge_base(base, branch) else {
            return Ok(Vec::new());
        };
        let landed = self.base_patch_ids(boundary, base_id);
        let mine = self.rev_list(boundary, branch_id)?;
        Ok(mine
            .into_iter()
            .map(|id| {
                let is_landed =
                    self.patch_id_of_commit(id).is_some_and(|patch| landed.contains(&patch));
                (id, is_landed)
            })
            .collect())
    }

    /// Hash the change between two trees. `None` for `old` means the empty
    /// tree.
    fn patch_id_between(
        &self,
        old: Option<&gix::Tree<'_>>,
        new: &gix::Tree<'_>,
    ) -> Option<PatchId> {
        let changes = self.inner().diff_tree_to_tree(old, Some(new), None).ok()?;
        let empty = self.inner().empty_tree();
        let old = old.unwrap_or(&empty);

        // Sorted, so two runs over the same change hash identically regardless
        // of the order the tree walk happened to report entries in.
        let mut parts: Vec<(String, String, Vec<u8>)> = Vec::new();
        for change in changes {
            use gix::object::tree::diff::ChangeDetached as C;
            let (path, source) = match &change {
                C::Addition { location, .. }
                | C::Deletion { location, .. }
                | C::Modification { location, .. } => (location.to_string(), location.to_string()),
                C::Rewrite { location, source_location, .. } => {
                    (location.to_string(), source_location.to_string())
                }
            };
            let before = super::diff::blob_at(old, &source);
            let after = super::diff::blob_at(new, &path);
            parts.push((path, source, hunk_bytes(before.as_deref(), after.as_deref())));
        }
        parts.sort();

        let mut hasher = gix::hash::hasher(gix::hash::Kind::Sha1);
        for (path, source, body) in parts {
            hasher.update(path.as_bytes());
            hasher.update(b"\0");
            hasher.update(source.as_bytes());
            hasher.update(b"\0");
            hasher.update(&body);
        }
        hasher.try_finalize().ok().map(PatchId)
    }

    fn tree_at(&self, id: gix::ObjectId) -> Option<gix::Tree<'_>> {
        self.inner().find_object(id).ok()?.peel_to_tree().ok()
    }
}

/// The content of a change, with no line numbers in it: every removed line
/// prefixed `-`, every added line prefixed `+`, hunk by hunk.
///
/// Omitting positions is the whole point — a commit rebased onto a different
/// base applies its identical change at different line numbers, and must hash
/// the same. Binary content is represented by its two blob hashes instead,
/// which is already a content identity.
fn hunk_bytes(before: Option<&[u8]>, after: Option<&[u8]>) -> Vec<u8> {
    let before = before.unwrap_or(&[]);
    let after = after.unwrap_or(&[]);
    if is_binary(before) || is_binary(after) {
        let mut out = b"binary\0".to_vec();
        out.extend_from_slice(&content_hash(before));
        out.extend_from_slice(&content_hash(after));
        return out;
    }
    let input = gix::diff::blob::InternedInput::new(before, after);
    let diff = gix::diff::blob::diff_with_slider_heuristics(super::DIFF_ALGORITHM, &input);
    let mut out = Vec::new();
    for hunk in diff.hunks() {
        for token in &input.before[hunk.before.start as usize..hunk.before.end as usize] {
            out.push(b'-');
            out.extend_from_slice(input.interner[*token]);
            out.push(b'\n');
        }
        for token in &input.after[hunk.after.start as usize..hunk.after.end as usize] {
            out.push(b'+');
            out.extend_from_slice(input.interner[*token]);
            out.push(b'\n');
        }
    }
    out
}

fn is_binary(content: &[u8]) -> bool {
    content.iter().take(8000).any(|b| *b == 0)
}

/// Content identity for a blob whose lines cannot be diffed. Empty content
/// hashes to a fixed sentinel rather than a digest, so an added binary file and
/// a deleted one never collide.
fn content_hash(content: &[u8]) -> Vec<u8> {
    let mut hasher = gix::hash::hasher(gix::hash::Kind::Sha1);
    hasher.update(content);
    hasher.try_finalize().map(|id| id.as_slice().to_vec()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::testrepo::TestRepo;

    /// `main` with one commit, `feature` with two of its own.
    fn branched() -> TestRepo {
        let repo = TestRepo::new();
        repo.git(&["checkout", "--quiet", "-b", "feature"]);
        repo.commit_file("a.txt", "alpha\n");
        repo.commit_file("b.txt", "beta\n");
        repo
    }

    #[test]
    fn a_commit_and_its_cherry_pick_share_a_patch_id() {
        let repo = TestRepo::new();
        repo.git(&["checkout", "--quiet", "-b", "feature"]);
        let original = repo.commit_file("shared.txt", "content\n");
        repo.git(&["checkout", "--quiet", "main"]);
        // An unrelated commit first, so the cherry-pick lands at a different
        // position with a different sha and a different parent.
        repo.commit_file("unrelated.txt", "noise\n");
        repo.git(&["cherry-pick", "--quiet", &original]);
        let picked = repo.rev_parse("HEAD");

        let git = Repo::open(repo.path()).expect("open");
        let a = git.patch_id_of_commit(gix::ObjectId::from_hex(original.as_bytes()).unwrap());
        let b = git.patch_id_of_commit(gix::ObjectId::from_hex(picked.as_bytes()).unwrap());
        assert!(a.is_some());
        assert_eq!(a, b, "a cherry-pick must be patch-identical to its source");
    }

    #[test]
    fn different_changes_have_different_patch_ids() {
        let repo = branched();
        let git = Repo::open(repo.path()).expect("open");
        let head = git.head_id().expect("head");
        let parent = git.rev_list(git.merge_base("main", "HEAD").unwrap(), head).unwrap();
        let ids: Vec<Option<PatchId>> =
            parent.iter().map(|id| git.patch_id_of_commit(*id)).collect();
        assert_eq!(ids.len(), 2);
        assert_ne!(ids[0], ids[1]);
    }

    #[test]
    fn cherry_reports_unlanded_commits() {
        let repo = branched();
        let git = Repo::open(repo.path()).expect("open");
        let result = git.cherry("main", "feature").expect("cherry");
        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|(_, landed)| !landed), "nothing has landed yet");
    }

    #[test]
    fn cherry_matches_git_cherry_after_a_rebase_merge() {
        let repo = branched();
        // Rebase-merge: main gets patch-identical copies under new shas. The
        // unrelated commit first is load-bearing — cherry-picking straight onto
        // the merge-base reproduces byte-identical commits (same tree, same
        // parent, same second), so feature would be *contained* in main and
        // there would be no divergence left for either implementation to judge.
        repo.git(&["checkout", "--quiet", "main"]);
        repo.commit_file("unrelated.txt", "noise\n");
        repo.git(&["cherry-pick", "--quiet", "feature~1", "feature"]);
        repo.git(&["checkout", "--quiet", "feature"]);

        let expected_landed = repo
            .git(&["cherry", "main", "feature"])
            .lines()
            .filter(|l| l.trim_start().starts_with('-'))
            .count();
        assert_eq!(expected_landed, 2, "git itself must see these as landed");

        let git = Repo::open(repo.path()).expect("open");
        let landed = git.cherry("main", "feature").unwrap().iter().filter(|(_, l)| *l).count();
        assert_eq!(landed, expected_landed);
    }

    #[test]
    fn a_squash_merge_is_found_by_the_cumulative_patch_id() {
        let repo = branched();
        let boundary = repo.git(&["merge-base", "main", "feature"]);
        let tip = repo.rev_parse("feature");

        repo.git(&["checkout", "--quiet", "main"]);
        repo.git(&["merge", "--squash", "feature"]);
        repo.git(&["commit", "--quiet", "-m", "squashed feature"]);
        let squashed = repo.rev_parse("HEAD");

        let git = Repo::open(repo.path()).expect("open");
        let cumulative = git
            .cumulative_patch_id(
                gix::ObjectId::from_hex(boundary.as_bytes()).unwrap(),
                gix::ObjectId::from_hex(tip.as_bytes()).unwrap(),
            )
            .expect("cumulative id");
        let squash_commit =
            git.patch_id_of_commit(gix::ObjectId::from_hex(squashed.as_bytes()).unwrap());
        assert_eq!(
            Some(cumulative),
            squash_commit,
            "the branch's cumulative diff is exactly what the squash commit holds"
        );
    }

    #[test]
    fn per_commit_ids_do_not_match_a_squash() {
        // The case that made `git cherry` alone insufficient: a squash commit
        // is patch-identical to the branch as a whole, but to none of its
        // individual commits.
        let repo = branched();
        repo.git(&["checkout", "--quiet", "main"]);
        repo.git(&["merge", "--squash", "feature"]);
        repo.git(&["commit", "--quiet", "-m", "squashed"]);
        repo.git(&["checkout", "--quiet", "feature"]);

        let git = Repo::open(repo.path()).expect("open");
        let landed = git.cherry("main", "feature").unwrap().iter().filter(|(_, l)| *l).count();
        assert_eq!(landed, 0, "squash hides individual commits from patch comparison");
    }

    #[test]
    fn binary_changes_hash_by_content() {
        let repo = TestRepo::new();
        repo.git(&["checkout", "--quiet", "-b", "feature"]);
        std::fs::write(repo.path().join("blob.bin"), [0u8, 7, 0, 9]).expect("write");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "--quiet", "-m", "binary"]);
        let original = repo.rev_parse("HEAD");

        repo.git(&["checkout", "--quiet", "main"]);
        repo.git(&["cherry-pick", "--quiet", &original]);
        let picked = repo.rev_parse("HEAD");

        let git = Repo::open(repo.path()).expect("open");
        assert_eq!(
            git.patch_id_of_commit(gix::ObjectId::from_hex(original.as_bytes()).unwrap()),
            git.patch_id_of_commit(gix::ObjectId::from_hex(picked.as_bytes()).unwrap()),
        );
    }
}
