//! Patch identity — "does the base branch already contain this change?" The
//! in-process replacement for `git cherry`, and the ugliest shell-out in the
//! workspace with it: asking `git cherry` whether a *squashed* branch had landed
//! meant `commit-tree` writing a real object for its cumulative tree, then deleting
//! the loose object so the poll didn't litter thousands of dead objects a day. In
//! process a patch id is computed from trees that already exist, and thrown away.

use std::cell::RefCell;
use std::collections::HashMap;

use super::{Repo, Result};

/// The identity of a change, independent of where or when it was committed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PatchId(gix::ObjectId);

impl std::fmt::Display for PatchId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// Which paths a change touches, hashed without reading a blob. Equal patch ids
/// imply equal shapes, so content is diffed only where both sides share one: a
/// tree diff costs milliseconds, the content diff behind a patch id can cost
/// seconds — one 68k-file base commit cost 14 s to hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct PatchShape(gix::ObjectId);

/// What the base branch gained since a boundary, for "is this change already
/// there?" — see [`Repo::base_patches`]. A base commit's patch id is computed
/// the first time a change of its shape asks.
#[derive(Debug, Default)]
pub struct BasePatches {
    by_shape: HashMap<PatchShape, Vec<gix::ObjectId>>,
    ids: RefCell<HashMap<gix::ObjectId, Option<PatchId>>>,
}

impl BasePatches {
    pub fn is_empty(&self) -> bool {
        self.by_shape.is_empty()
    }
}

/// Ceiling on how many base-branch commits are hashed, since every one costs a
/// tree diff. Safe in one direction only — the one that matters: a truncated
/// set can only *fail* to recognize a landing, never invent one, so the failure
/// mode is a merged task left uncleaned rather than deleted work.
const MAX_BASE_PATCHES: usize = 4096;

impl Repo {
    /// The patch id of a commit: its change against its first parent. `None`
    /// for an unreadable commit; a root commit hashes as the addition of its
    /// whole tree.
    pub fn patch_id_of_commit(&self, id: gix::ObjectId) -> Option<PatchId> {
        let (parent, tree) = self.commit_trees(id)?;
        self.patch_between(parent.as_ref(), &tree)
    }

    /// Whether `base` already holds the change commit `id` made.
    pub fn commit_landed_in(&self, id: gix::ObjectId, base: &BasePatches) -> bool {
        if base.is_empty() {
            return false;
        }
        self.commit_trees(id)
            .is_some_and(|(parent, tree)| self.landed_between(parent.as_ref(), &tree, base))
    }

    /// Whether `base` already holds the cumulative change `from..to` — a squash.
    pub fn cumulative_landed_in(
        &self,
        from: gix::ObjectId,
        to: gix::ObjectId,
        base: &BasePatches,
    ) -> bool {
        if base.is_empty() {
            return false;
        }
        let (Some(old), Some(new)) = (self.tree_at(from), self.tree_at(to)) else {
            return false;
        };
        self.landed_between(Some(&old), &new, base)
    }

    /// The patch id of the *cumulative* change between two revisions — what a
    /// squash merge collapses a branch into. This is the probe that recognizes
    /// a squash-merged branch: its whole diff since the merge-base, as one
    /// patch, is what landed on the base under a brand new sha.
    pub fn cumulative_patch_id(&self, from: gix::ObjectId, to: gix::ObjectId) -> Option<PatchId> {
        let old = self.tree_at(from)?;
        let new = self.tree_at(to)?;
        self.patch_between(Some(&old), &new)
    }

    /// Every commit the base branch gained since `boundary`, for membership
    /// tests. See [`MAX_BASE_PATCHES`] for the bound and why exceeding it is safe.
    pub fn base_patches(&self, boundary: gix::ObjectId, base_tip: gix::ObjectId) -> BasePatches {
        let mut out = BasePatches::default();
        let Ok(commits) = self.rev_list(boundary, base_tip) else {
            return out;
        };
        for id in commits.into_iter().take(MAX_BASE_PATCHES) {
            let Some((parent, tree)) = self.commit_trees(id) else {
                continue;
            };
            if let Some(shape) =
                self.changed_paths(parent.as_ref(), &tree).and_then(|p| shape_of(&p))
            {
                out.by_shape.entry(shape).or_default().push(id);
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
        let landed = self.base_patches(boundary, base_id);
        let mine = self.rev_list(boundary, branch_id)?;
        Ok(mine.into_iter().map(|id| (id, self.commit_landed_in(id, &landed))).collect())
    }

    /// The shape gates the content diff, so a change the base can't hold never
    /// reads a blob.
    fn landed_between(
        &self,
        old: Option<&gix::Tree<'_>>,
        new: &gix::Tree<'_>,
        base: &BasePatches,
    ) -> bool {
        let Some(paths) = self.changed_paths(old, new) else {
            return false;
        };
        let Some(candidates) = shape_of(&paths).and_then(|shape| base.by_shape.get(&shape)) else {
            return false;
        };
        let Some(mine) = self.patch_of_paths(old, new, paths) else {
            return false;
        };
        candidates.iter().any(|id| {
            let theirs =
                *base.ids.borrow_mut().entry(*id).or_insert_with(|| self.patch_id_of_commit(*id));
            theirs == Some(mine)
        })
    }

    fn patch_between(&self, old: Option<&gix::Tree<'_>>, new: &gix::Tree<'_>) -> Option<PatchId> {
        let paths = self.changed_paths(old, new)?;
        self.patch_of_paths(old, new, paths)
    }

    /// Every path the change touches, sorted. **Rename-blind**: rename tracking
    /// over a commit deleting 68k files took 149 s to find none, against 24 ms
    /// without — and both sides of every comparison hash the same way, so a
    /// renamed file still matches as its deletion plus its addition.
    fn changed_paths(
        &self,
        old: Option<&gix::Tree<'_>>,
        new: &gix::Tree<'_>,
    ) -> Option<Vec<String>> {
        let opts = gix::diff::Options::default().with_rewrites(None);
        let changes = self.inner().diff_tree_to_tree(old, Some(new), Some(opts)).ok()?;
        let mut paths: Vec<String> = changes
            .iter()
            .map(|change| {
                use gix::object::tree::diff::ChangeDetached as C;
                match change {
                    C::Addition { location, .. }
                    | C::Deletion { location, .. }
                    | C::Modification { location, .. }
                    | C::Rewrite { location, .. } => location.to_string(),
                }
            })
            .collect();
        paths.sort();
        Some(paths)
    }

    fn patch_of_paths(
        &self,
        old: Option<&gix::Tree<'_>>,
        new: &gix::Tree<'_>,
        paths: Vec<String>,
    ) -> Option<PatchId> {
        let empty = self.inner().empty_tree();
        let old = old.unwrap_or(&empty);
        let mut hasher = gix::hash::hasher(gix::hash::Kind::Sha1);
        for path in paths {
            let before = super::diff::blob_at(old, &path);
            let after = super::diff::blob_at(new, &path);
            hasher.update(path.as_bytes());
            hasher.update(b"\0");
            hasher.update(&hunk_bytes(before.as_deref(), after.as_deref()));
        }
        hasher.try_finalize().ok().map(PatchId)
    }

    fn commit_trees(&self, id: gix::ObjectId) -> Option<(Option<gix::Tree<'_>>, gix::Tree<'_>)> {
        let commit = self.inner().find_object(id).ok()?.try_into_commit().ok()?;
        let tree = commit.tree().ok()?;
        let parent = commit.parent_ids().next().and_then(|p| self.tree_at(p.detach()));
        Some((parent, tree))
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

fn shape_of(paths: &[String]) -> Option<PatchShape> {
    let mut hasher = gix::hash::hasher(gix::hash::Kind::Sha1);
    for path in paths {
        hasher.update(path.as_bytes());
        hasher.update(b"\0");
    }
    hasher.try_finalize().ok().map(PatchShape)
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

    fn oid(hex: &str) -> gix::ObjectId {
        gix::ObjectId::from_hex(hex.as_bytes()).unwrap()
    }

    #[test]
    fn a_squash_is_landed_and_a_same_paths_rewrite_is_not() {
        let repo = branched();
        let boundary = oid(&repo.git(&["merge-base", "main", "feature"]));
        let tip = oid(&repo.rev_parse("feature"));
        repo.git(&["checkout", "--quiet", "main"]);
        repo.git(&["merge", "--squash", "feature"]);
        repo.git(&["commit", "--quiet", "-m", "squashed"]);
        let squashed = oid(&repo.rev_parse("HEAD"));
        // The same two paths with other content: the shape matches, the patch must not.
        repo.git(&[
            "checkout",
            "--quiet",
            "-b",
            "lookalike",
            &boundary.to_string(),
        ]);
        repo.commit_file("a.txt", "not alpha\n");
        repo.commit_file("b.txt", "not beta\n");
        let lookalike = oid(&repo.rev_parse("HEAD"));

        let git = Repo::open(repo.path()).expect("open");
        let base = git.base_patches(boundary, squashed);
        assert!(git.cumulative_landed_in(boundary, tip, &base));
        assert!(!git.cumulative_landed_in(boundary, lookalike, &base));
        let nothing = git.base_patches(boundary, boundary);
        assert!(nothing.is_empty());
        assert!(!git.cumulative_landed_in(boundary, tip, &nothing));
    }

    #[test]
    fn a_cherry_picked_rename_is_landed() {
        let repo = TestRepo::new();
        repo.commit_file("old.txt", "kept content\n");
        repo.git(&["checkout", "--quiet", "-b", "feature"]);
        repo.git(&["mv", "old.txt", "new.txt"]);
        repo.git(&["commit", "--quiet", "-m", "rename"]);
        let renamed = repo.rev_parse("HEAD");
        repo.git(&["checkout", "--quiet", "main"]);
        let boundary = oid(&repo.rev_parse("HEAD"));
        repo.commit_file("unrelated.txt", "noise\n");
        repo.git(&["cherry-pick", "--quiet", &renamed]);

        let git = Repo::open(repo.path()).expect("open");
        let base = git.base_patches(boundary, oid(&repo.rev_parse("HEAD")));
        assert!(git.commit_landed_in(oid(&renamed), &base));
    }

    #[test]
    fn per_commit_ids_do_not_match_a_squash() {
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
