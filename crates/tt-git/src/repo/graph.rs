//! Commit-graph queries: merge-base, ahead/behind, reachability, and the
//! commit walks the task machinery counts work with.
//!
//! These replace `merge-base`, `rev-list --count`, `rev-list --left-right`,
//! `merge-base --is-ancestor` and `log -1 --format=%ct` — together the majority
//! of the subprocesses the Agentboard poll used to spawn.

use super::{Repo, Result};

impl Repo {
    /// Best common ancestor of two revisions, or `None` when they share no
    /// history (or either does not resolve).
    pub fn merge_base(&self, a: &str, b: &str) -> Option<gix::ObjectId> {
        let a = self.resolve(a)?;
        let b = self.resolve(b)?;
        self.inner().merge_base(a, b).ok().map(|id| id.detach())
    }

    /// Commits on `head` that `base` lacks, and vice versa — the pair
    /// `rev-list --left-right --count base...head` reports, in that order:
    /// `(ahead, behind)`.
    ///
    /// `(0, 0)` when either side does not resolve, matching the empty-output
    /// degradation the shell-out path had.
    pub fn ahead_behind(&self, base: &str, head: &str) -> (i64, i64) {
        let Some(base_id) = self.resolve(base) else {
            return (0, 0);
        };
        let Some(head_id) = self.resolve(head) else {
            return (0, 0);
        };
        let Some(merge_base) = self.inner().merge_base(base_id, head_id).ok().map(|id| id.detach())
        else {
            return (0, 0);
        };
        let ahead = self.count_since(merge_base, head_id);
        let behind = self.count_since(merge_base, base_id);
        (ahead, behind)
    }

    /// Number of commits reachable from `tip` but not from `boundary`.
    fn count_since(&self, boundary: gix::ObjectId, tip: gix::ObjectId) -> i64 {
        if boundary == tip {
            return 0;
        }
        self.inner()
            .rev_walk([tip])
            .with_hidden([boundary])
            .all()
            .map(|walk| walk.filter_map(std::result::Result::ok).count() as i64)
            .unwrap_or(0)
    }

    /// Commits in `boundary..tip`, newest first — `git rev-list` order.
    pub fn rev_list(
        &self,
        boundary: gix::ObjectId,
        tip: gix::ObjectId,
    ) -> Result<Vec<gix::ObjectId>> {
        if boundary == tip {
            return Ok(Vec::new());
        }
        let walk = self
            .inner()
            .rev_walk([tip])
            .with_hidden([boundary])
            .all()
            .map_err(|e| super::GitError::Read(e.to_string()))?;
        Ok(walk.filter_map(std::result::Result::ok).map(|info| info.id).collect())
    }

    /// Is `ancestor` reachable from `descendant`? The in-process
    /// `git merge-base --is-ancestor`, whose exit-code-only answer was the one
    /// git call in this codebase that could not be read from stdout.
    pub fn is_ancestor(&self, ancestor: &str, descendant: &str) -> bool {
        let (Some(ancestor), Some(descendant)) = (self.resolve(ancestor), self.resolve(descendant))
        else {
            return false;
        };
        if ancestor == descendant {
            return true;
        }
        self.inner().merge_base(ancestor, descendant).is_ok_and(|base| base.detach() == ancestor)
    }

    /// Commits reachable from `HEAD` but from no branch and no remote — work
    /// that only a detached HEAD holds, and the one axis removing a checkout
    /// genuinely destroys (`rev-list --count HEAD --not --branches --remotes`).
    pub fn orphaned_count(&self) -> u64 {
        let Some(head) = self.head_id() else {
            return 0;
        };
        let mut hidden = Vec::new();
        if let Ok(platform) = self.inner().references()
            && let Ok(all) = platform.all()
        {
            for reference in all.flatten() {
                let name = reference.name().as_bstr().to_string();
                if (name.starts_with("refs/heads/") || name.starts_with("refs/remotes/"))
                    && let Some(id) = reference.try_id()
                {
                    hidden.push(id.detach());
                }
            }
        }
        self.inner()
            .rev_walk([head])
            .with_hidden(hidden)
            .all()
            .map(|walk| walk.filter_map(std::result::Result::ok).count() as u64)
            .unwrap_or(0)
    }

    /// Epoch seconds of the newest commit in `base..HEAD` — the branch's own
    /// most recent work, `None` when it has added no commits of its own.
    pub fn last_own_commit_unix(&self, base: &str) -> Option<i64> {
        let head = self.head_id()?;
        let boundary = self.merge_base(base, "HEAD")?;
        let commits = self.rev_list(boundary, head).ok()?;
        let newest = commits.first()?;
        let commit = self.inner().find_object(*newest).ok()?.try_into_commit().ok()?;
        commit.time().ok().map(|time| time.seconds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::testrepo::TestRepo;

    /// A repo with `main` at 1 commit and `feature` two commits beyond it,
    /// while `main` itself moved on by one — the ordinary "3 ahead, 1 behind"
    /// shape.
    fn diverged() -> TestRepo {
        let repo = TestRepo::new();
        repo.git(&["checkout", "--quiet", "-b", "feature"]);
        repo.commit_file("a.txt", "a\n");
        repo.commit_file("b.txt", "b\n");
        repo.git(&["checkout", "--quiet", "main"]);
        repo.commit_file("c.txt", "c\n");
        repo.git(&["update-ref", "refs/remotes/origin/main", "main"]);
        repo.git(&["checkout", "--quiet", "feature"]);
        repo
    }

    #[test]
    fn merge_base_matches_git() {
        let repo = diverged();
        let git = Repo::open(repo.path()).expect("open");
        assert_eq!(
            git.merge_base("origin/main", "HEAD").map(|id| id.to_string()),
            Some(repo.git(&["merge-base", "origin/main", "HEAD"]))
        );
    }

    #[test]
    fn ahead_behind_matches_git() {
        let repo = diverged();
        let git = Repo::open(repo.path()).expect("open");
        // `rev-list --left-right --count origin/main...HEAD` prints "behind<TAB>ahead".
        let expected = repo.git(&["rev-list", "--left-right", "--count", "origin/main...HEAD"]);
        let mut parts = expected.split_whitespace();
        let behind: i64 = parts.next().expect("behind").parse().expect("int");
        let ahead: i64 = parts.next().expect("ahead").parse().expect("int");
        assert_eq!(git.ahead_behind("origin/main", "HEAD"), (ahead, behind));
        assert_eq!((ahead, behind), (2, 1), "fixture sanity");
    }

    #[test]
    fn ahead_behind_is_zero_when_the_base_is_missing() {
        let repo = TestRepo::new();
        let git = Repo::open(repo.path()).expect("open");
        assert_eq!(git.ahead_behind("origin/nope", "HEAD"), (0, 0));
    }

    #[test]
    fn rev_list_is_newest_first() {
        let repo = diverged();
        let git = Repo::open(repo.path()).expect("open");
        let boundary = git.merge_base("origin/main", "HEAD").expect("merge base");
        let head = git.head_id().expect("head");
        let seen: Vec<String> =
            git.rev_list(boundary, head).expect("walk").iter().map(|id| id.to_string()).collect();
        let expected: Vec<String> = repo
            .git(&["rev-list", &format!("{boundary}..HEAD")])
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(seen, expected);
    }

    #[test]
    fn is_ancestor_matches_merge_base_is_ancestor() {
        let repo = diverged();
        let git = Repo::open(repo.path()).expect("open");
        assert!(git.is_ancestor("origin/main", "origin/main"));
        assert!(!git.is_ancestor("HEAD", "origin/main"), "feature has not landed");
        let base = repo.git(&["merge-base", "origin/main", "HEAD"]);
        assert!(git.is_ancestor(&base, "HEAD"));
    }

    #[test]
    fn orphaned_count_sees_only_unreferenced_work() {
        let repo = TestRepo::new();
        let git = Repo::open(repo.path()).expect("open");
        assert_eq!(git.orphaned_count(), 0);

        repo.git(&["checkout", "--quiet", "-b", "scratch"]);
        repo.commit_file("orphan.txt", "x\n");
        let sha = repo.rev_parse("HEAD");
        repo.git(&["checkout", "--quiet", "main"]);
        repo.git(&["branch", "-D", "scratch"]);
        repo.git(&["checkout", "--quiet", &sha]);

        let git = Repo::open(repo.path()).expect("open");
        assert_eq!(git.orphaned_count(), 1, "a detached commit on no branch is orphaned");
    }

    #[test]
    fn last_own_commit_is_the_branch_tip_time() {
        let repo = diverged();
        let git = Repo::open(repo.path()).expect("open");
        let expected: i64 = repo.git(&["log", "-1", "--format=%ct", "HEAD"]).parse().expect("int");
        assert_eq!(git.last_own_commit_unix("origin/main"), Some(expected));
    }

    #[test]
    fn last_own_commit_is_none_on_the_base_branch() {
        let repo = TestRepo::new();
        let git = Repo::open(repo.path()).expect("open");
        assert_eq!(git.last_own_commit_unix("origin/main"), None);
    }
}
