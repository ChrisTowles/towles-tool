//! In-process git, via [gitoxide](https://github.com/GitoxideLabs/gitoxide). Every
//! *read* of a repository here goes through it instead of spawning `git`: the
//! Agentboard poll alone ran ~100k subprocesses a day, each a fork, exec, config
//! parse and ref-store load thrown away microseconds later. The same answers come
//! back 10–100× faster from a cached [`Repo`] (`rev-parse HEAD`: 0.75ms vs 0.01ms).
//!
//! Three operations still shell out, none an oversight: **worktree
//! add/remove/prune** (gitoxide's worktree API is read-only), **`merge
//! --ff-only`** (it updates the working tree, which gitoxide cannot), and
//! **`fetch`** (network-bound, so in-process buys nothing measurable).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

mod diff;
mod graph;
mod patch;
mod staging;
mod status;

pub use diff::{Changes, CommitStat, DiffTotals, FileChange, UntrackedCap};

pub use patch::PatchId;
pub use staging::StageState;
pub use status::{StatusEntry, StatusSummary};

/// Myers because that is git's default, and these numbers sit beside the ones the
/// user gets from `git diff`: on this repo's `Cargo.lock`, Histogram reports
/// `+1226 −2` where git reports `+1310 −86`.
pub(crate) const DIFF_ALGORITHM: gix::diff::blob::Algorithm = gix::diff::blob::Algorithm::Myers;

/// A git read that did not answer. Deliberately coarse: every caller degrades to a
/// conservative default rather than branching on *why*.
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("not a git repository: {0}")]
    NotARepo(String),
    #[error("cannot open git repository at {path}: {detail}")]
    Open { path: String, detail: String },
    #[error("git read failed: {0}")]
    Read(String),
    /// A write that didn't land — surfaced to the user, never defaulted away.
    #[error("git write failed: {0}")]
    Write(String),
    #[error("no such revision: {0}")]
    NoSuchRev(String),
}

pub type Result<T> = std::result::Result<T, GitError>;

/// One open repository per folder, shared across polls: opening is the expensive
/// part of gitoxide (~0.3ms), the queries afterwards are microseconds. Config is
/// parsed once at open, so [`RepoCache::open`] stats `config` and reopens.
#[derive(Debug, Default)]
pub struct RepoCache {
    entries: Mutex<HashMap<PathBuf, Entry>>,
}

#[derive(Debug)]
struct Entry {
    repo: gix::ThreadSafeRepository,
    /// A `remote set-url` is otherwise invisible to a long-lived handle.
    config_stamp: Option<std::time::SystemTime>,
}

impl RepoCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// [`GitError::NotARepo`] for a plain directory *and* a missing one: callers
    /// treat both as "no git info", and only the filesystem can tell them apart.
    pub fn open(&self, dir: &Path) -> Result<Repo> {
        let key = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        let mut entries = self.lock();
        if let Some(entry) = entries.get(&key)
            && config_stamp(&entry.repo) == entry.config_stamp
        {
            return Ok(Repo { repo: entry.repo.to_thread_local() });
        }
        let repo = gix::open(&key).map_err(|e| match e {
            gix::open::Error::NotARepository { .. } => {
                GitError::NotARepo(key.display().to_string())
            }
            other => GitError::Open { path: key.display().to_string(), detail: other.to_string() },
        })?;
        let repo = repo.into_sync();
        let handle = repo.to_thread_local();
        entries.insert(key, Entry { config_stamp: config_stamp(&repo), repo });
        Ok(Repo { repo: handle })
    }

    /// Nothing breaks if a removed checkout is never forgotten, but its ODB keeps
    /// file handles alive for nothing.
    pub fn forget(&self, dir: &Path) {
        let key = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        self.lock().remove(&key);
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// A pure memoization of on-disk state, so recovering a poisoned guard beats
    /// propagating a panic into a status poll.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Entry>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn config_stamp(repo: &gix::ThreadSafeRepository) -> Option<std::time::SystemTime> {
    std::fs::metadata(repo.to_thread_local().common_dir().join("config"))
        .and_then(|m| m.modified())
        .ok()
}

/// One cache rather than one per caller: the Agentboard poll, the task machinery
/// and the CLI all read the same handful of checkouts.
pub fn cache() -> &'static RepoCache {
    static CACHE: std::sync::OnceLock<RepoCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(RepoCache::new)
}

pub fn open(dir: &Path) -> Result<Repo> {
    cache().open(dir)
}

/// `git rev-parse --show-toplevel`, for a path from outside where [`open`]'s
/// "caller already knows the root" doesn't hold. Not the env-override variant: a
/// stray `GIT_DIR` in the caller's shell must not redirect the answer.
pub fn discover_root(path: &Path) -> Option<PathBuf> {
    // Handed a *file* — the ordinary operand — gitoxide reports "not a
    // repository" instead of walking up from its parent.
    let start = if path.is_dir() { path } else { path.parent()? };
    let repo = gix::discover(start).ok()?;
    let workdir = repo.workdir()?;
    Some(std::fs::canonicalize(workdir).unwrap_or_else(|_| workdir.to_path_buf()))
}

/// Drop `dir` from the process-wide [`cache`] — for a checkout being removed.
pub fn forget(dir: &Path) {
    cache().forget(dir);
}

/// Cheap from [`RepoCache::open`], not `Send` — one folder's work, not threads.
pub struct Repo {
    repo: gix::Repository,
}

impl std::fmt::Debug for Repo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Repo").field("git_dir", &self.repo.git_dir()).finish()
    }
}

impl Repo {
    pub fn open(dir: &Path) -> Result<Self> {
        let repo = gix::open(dir).map_err(|e| match e {
            gix::open::Error::NotARepository { .. } => {
                GitError::NotARepo(dir.display().to_string())
            }
            other => GitError::Open { path: dir.display().to_string(), detail: other.to_string() },
        })?;
        Ok(Self { repo })
    }

    pub fn inner(&self) -> &gix::Repository {
        &self.repo
    }

    /// `.git` for a main worktree, `<repo>/.git/worktrees/<name>` for a linked
    /// one.
    pub fn git_dir(&self) -> PathBuf {
        self.repo.git_dir().to_path_buf()
    }

    /// Identical across every linked worktree of one repo and nowhere else — the
    /// Folder Rail's grouping key. Canonicalized, so two spellings of one
    /// directory never read as two repos.
    pub fn common_dir(&self) -> PathBuf {
        let raw = self.repo.common_dir();
        std::fs::canonicalize(raw).unwrap_or_else(|_| raw.to_path_buf())
    }

    pub fn head_branch(&self) -> Option<String> {
        self.repo.head_name().ok().flatten().map(|name| name.shorten().to_string())
    }

    /// `None` on an unborn branch.
    pub fn head_id(&self) -> Option<gix::ObjectId> {
        self.repo.head_id().ok().map(|id| id.detach())
    }

    /// `git rev-parse --verify --quiet`: `None` when the spec names nothing.
    pub fn resolve(&self, spec: &str) -> Option<gix::ObjectId> {
        self.repo.rev_parse_single(spec).ok().map(|id| id.detach())
    }

    pub fn has_rev(&self, spec: &str) -> bool {
        self.resolve(spec).is_some()
    }

    /// `git remote get-url origin`, or `None` when the repo has no origin.
    pub fn origin_url(&self) -> Option<String> {
        let remote = self.repo.find_remote("origin").ok()?;
        let url = remote.url(gix::remote::Direction::Fetch)?;
        Some(url.to_bstring().to_string())
    }

    /// The `[gone]` of `%(upstream:track)`, distinct from "no upstream configured":
    /// a branch that was never pushed has not had anything deleted.
    pub fn upstream_gone(&self, branch: &str) -> bool {
        let Ok(Some(reference)) = self.repo.try_find_reference(branch) else {
            return false;
        };
        let Some(Ok(upstream)) = self
            .repo
            .branch_remote_tracking_ref_name(reference.name(), gix::remote::Direction::Fetch)
        else {
            return false;
        };
        // Configured, but its remote-tracking ref is gone: `fetch --prune`
        // after the remote branch was deleted.
        self.repo.try_find_reference(upstream.as_ref().as_bstr()).ok().flatten().is_none()
    }

    /// Whether `branch` ever reached the remote, from local refs alone — the free
    /// gate in front of asking GitHub. `false` only where local state *proves* it
    /// never did; a pruned `[gone]` upstream and a vanished branch both answer
    /// `true`, which is how a merged PR's branch looks.
    pub fn branch_was_pushed(&self, branch: &str) -> bool {
        self.has_rev(&format!("refs/remotes/origin/{branch}"))
            || self.upstream_gone(&format!("refs/heads/{branch}"))
            || !self.has_rev(&format!("refs/heads/{branch}"))
    }

    pub fn local_branches(&self) -> Vec<String> {
        let Ok(platform) = self.repo.references() else {
            return Vec::new();
        };
        let Ok(branches) = platform.prefixed("refs/heads/") else {
            return Vec::new();
        };
        branches
            .flatten()
            .filter_map(|r| r.name().category_and_short_name().map(|(_, name)| name.to_string()))
            .collect()
    }

    /// Force semantics, like the `git branch -D` it replaces: whether the branch
    /// has landed is the caller's decision.
    pub fn delete_branch(&self, branch: &str) -> Result<()> {
        let full = format!("refs/heads/{branch}");
        let name = gix::refs::FullName::try_from(full.as_str())
            .map_err(|e| GitError::Read(e.to_string()))?;
        self.repo
            .edit_reference(gix::refs::transaction::RefEdit {
                change: gix::refs::transaction::Change::Delete {
                    expected: gix::refs::transaction::PreviousValue::MustExist,
                    log: gix::refs::transaction::RefLog::AndReference,
                },
                name,
                deref: false,
            })
            .map_err(|e| GitError::Read(e.to_string()))?;
        Ok(())
    }

    /// `git check-ignore -q`. Errors rather than answering when the exclude stack
    /// won't load: the two callers pick opposite safe defaults.
    pub fn is_ignored(&self, relative_path: &str) -> Result<bool> {
        let index = self.repo.index_or_empty().map_err(|e| GitError::Read(e.to_string()))?;
        let mut excludes = self
            .repo
            .excludes(
                &index,
                None,
                gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped,
            )
            .map_err(|e| GitError::Read(e.to_string()))?;
        let platform = excludes
            .at_path(relative_path, Some(gix::index::entry::Mode::FILE))
            .map_err(|e| GitError::Read(e.to_string()))?;
        Ok(platform.excluded_kind().is_some())
    }

    /// The stash is the reflog of `refs/stash`, so an empty count and a
    /// missing ref are the same answer: nothing stashed.
    pub fn stash_count(&self) -> usize {
        let Ok(Some(stash)) = self.repo.try_find_reference("refs/stash") else {
            return 0;
        };
        stash.log_iter().all().ok().flatten().map(|log| log.flatten().count()).unwrap_or(0)
    }

    /// `git checkout -b <branch>` for the one case this workspace performs it in: a
    /// checkout the caller has already verified is **clean**. That precondition is
    /// what makes this two ref writes rather than a checkout — the commit is already
    /// checked out. A caller with a dirty tree must not use it.
    pub fn create_branch_at_head(&self, branch: &str) -> Result<()> {
        let head = self.head_id().ok_or_else(|| GitError::NoSuchRev("HEAD".to_string()))?;
        let full = format!("refs/heads/{branch}");
        if self.has_rev(&full) {
            return Err(GitError::Read(format!("branch {branch} already exists")));
        }
        let name = gix::refs::FullName::try_from(full.as_str())
            .map_err(|e| GitError::Read(e.to_string()))?;
        self.repo
            .edit_reference(gix::refs::transaction::RefEdit {
                change: gix::refs::transaction::Change::Update {
                    log: gix::refs::transaction::LogChange {
                        mode: gix::refs::transaction::RefLog::AndReference,
                        force_create_reflog: false,
                        message: "branch: Created from HEAD".into(),
                    },
                    expected: gix::refs::transaction::PreviousValue::MustNotExist,
                    new: gix::refs::Target::Object(head),
                },
                name: name.clone(),
                deref: false,
            })
            .map_err(|e| GitError::Read(e.to_string()))?;
        // Symbolic, exactly as a checkout leaves it — an object target here
        // would detach HEAD instead.
        self.repo
            .edit_reference(gix::refs::transaction::RefEdit {
                change: gix::refs::transaction::Change::Update {
                    log: gix::refs::transaction::LogChange {
                        mode: gix::refs::transaction::RefLog::AndReference,
                        force_create_reflog: false,
                        message: format!("checkout: moving to {branch}").into(),
                    },
                    expected: gix::refs::transaction::PreviousValue::Any,
                    new: gix::refs::Target::Symbolic(name),
                },
                name: gix::refs::FullName::try_from("HEAD")
                    .map_err(|e| GitError::Read(e.to_string()))?,
                deref: false,
            })
            .map_err(|e| GitError::Read(e.to_string()))?;
        Ok(())
    }

    /// The main worktree first, then each linked one: [`gix::Repository::worktrees`]
    /// covers *linked* worktrees only, and dropping the main checkout would stop
    /// pulling a tracked task's primary into the Folder Rail.
    pub fn worktrees(&self) -> Vec<WorktreeEntry> {
        let mut out = Vec::new();
        let main = self
            .repo
            .main_repo()
            .ok()
            .and_then(|main| main.workdir().map(|w| w.to_path_buf()))
            .or_else(|| self.repo.workdir().map(|w| w.to_path_buf()));
        if let Some(dir) = main {
            out.push(WorktreeEntry { dir: canonical(&dir), is_main: true });
        }
        for proxy in self.repo.worktrees().into_iter().flatten() {
            if let Ok(base) = proxy.base() {
                out.push(WorktreeEntry { dir: canonical(&base), is_main: false });
            }
        }
        out
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeEntry {
    pub dir: String,
    pub is_main: bool,
}

/// Compared against caller-supplied directory strings, so a symlink spelled two
/// ways must not read as two checkouts.
fn canonical(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
pub(crate) mod testrepo;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::testrepo::TestRepo;

    #[test]
    fn open_reports_non_repo_directories() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cache = RepoCache::new();
        assert!(matches!(cache.open(dir.path()), Err(GitError::NotARepo(_))));
    }

    /// gitoxide won't discover from a file — see [`discover_root`].
    #[test]
    fn discover_root_walks_up_from_a_nested_file() {
        let repo = TestRepo::new();
        let nested = repo.path().join("src/deep");
        std::fs::create_dir_all(&nested).expect("mkdir");
        let file = nested.join("main.rs");
        std::fs::write(&file, "fn main() {}").expect("write");

        let root = std::fs::canonicalize(repo.path()).expect("canonicalize");
        assert_eq!(discover_root(&file).as_deref(), Some(root.as_path()));
        assert_eq!(discover_root(&nested).as_deref(), Some(root.as_path()));
    }

    #[test]
    fn discover_root_answers_none_outside_a_repository() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(discover_root(dir.path()).is_none());
        assert!(discover_root(&dir.path().join("nope.rs")).is_none());
    }

    #[test]
    fn cache_reuses_one_handle_per_folder() {
        let repo = TestRepo::new();
        let cache = RepoCache::new();
        assert!(cache.open(repo.path()).is_ok());
        assert!(cache.open(repo.path()).is_ok());
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn cache_reopens_after_a_config_change() {
        let repo = TestRepo::new();
        let cache = RepoCache::new();
        assert!(cache.open(repo.path()).expect("open").origin_url().is_none());
        repo.git(&["remote", "add", "origin", "https://example.com/x.git"]);
        assert_eq!(
            cache.open(repo.path()).expect("open").origin_url().as_deref(),
            Some("https://example.com/x.git"),
            "a cached handle must not serve a stale remote"
        );
    }

    #[test]
    fn forget_drops_the_entry() {
        let repo = TestRepo::new();
        let cache = RepoCache::new();
        assert!(cache.open(repo.path()).is_ok());
        cache.forget(repo.path());
        assert!(cache.is_empty());
    }

    #[test]
    fn head_branch_and_id_track_the_checkout() {
        let repo = TestRepo::new();
        let git = Repo::open(repo.path()).expect("open");
        assert_eq!(git.head_branch().as_deref(), Some("main"));
        assert_eq!(git.head_id().map(|id| id.to_string()), Some(repo.rev_parse("HEAD")));
    }

    #[test]
    fn resolve_answers_none_for_missing_revisions() {
        let repo = TestRepo::new();
        let git = Repo::open(repo.path()).expect("open");
        assert!(git.has_rev("main"));
        assert!(!git.has_rev("origin/nope"));
    }

    #[test]
    fn worktrees_lists_the_main_checkout_first() {
        let repo = TestRepo::new();
        let linked = repo.add_worktree("task-a", "feature-a");
        let git = Repo::open(repo.path()).expect("open");
        let seen = git.worktrees();
        assert!(seen.first().is_some_and(|w| w.is_main), "main worktree must come first");
        assert!(
            seen.iter().any(|w| w.dir == canonical(&linked) && !w.is_main),
            "linked worktree missing from {seen:?}"
        );
    }

    #[test]
    fn worktrees_from_a_linked_checkout_still_include_the_main_one() {
        let repo = TestRepo::new();
        let linked = repo.add_worktree("task-b", "feature-b");
        let git = Repo::open(&linked).expect("open linked");
        assert!(
            git.worktrees().iter().any(|w| w.is_main && w.dir == canonical(repo.path())),
            "a task must be able to discover its primary"
        );
    }

    #[test]
    fn delete_branch_removes_the_ref_and_nothing_else() {
        let repo = TestRepo::new();
        repo.git(&["branch", "doomed"]);
        let sha = repo.rev_parse("doomed");

        Repo::open(repo.path()).expect("open").delete_branch("doomed").expect("delete");

        assert!(
            !repo.git(&["branch", "--list", "doomed"]).contains("doomed"),
            "git must agree the branch is gone"
        );
        // The commit itself survives — deleting a ref is not deleting history.
        assert_eq!(repo.git(&["rev-parse", &sha]), sha);
    }

    #[test]
    fn delete_branch_reports_a_missing_branch() {
        let repo = TestRepo::new();
        assert!(Repo::open(repo.path()).expect("open").delete_branch("never-existed").is_err());
    }

    #[test]
    fn is_ignored_matches_git_check_ignore() {
        let repo = TestRepo::new();
        repo.write(".gitignore", ".env\nnode_modules/\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "--quiet", "-m", "ignore rules"]);

        let git = Repo::open(repo.path()).expect("open");
        assert!(git.is_ignored(".env").expect("rules load"));
        assert!(!git.is_ignored("README.md").expect("rules load"));
        assert!(!git.is_ignored("src/main.rs").expect("rules load"));
    }

    #[test]
    fn stash_count_matches_git_stash_list() {
        let repo = TestRepo::new();
        let git = Repo::open(repo.path()).expect("open");
        assert_eq!(git.stash_count(), 0);

        repo.write("README.md", "hello\nchanged\n");
        repo.git(&["stash", "push", "-q", "-m", "one"]);
        repo.write("README.md", "hello\nagain\n");
        repo.git(&["stash", "push", "-q", "-m", "two"]);

        let expected = repo.git(&["stash", "list"]).lines().count();
        assert_eq!(Repo::open(repo.path()).expect("open").stash_count(), expected);
        assert_eq!(expected, 2, "fixture sanity");
    }

    #[test]
    fn create_branch_at_head_switches_like_checkout_b() {
        let repo = TestRepo::new();
        Repo::open(repo.path()).expect("open").create_branch_at_head("feat/new").expect("create");

        // Ask git itself: the point is the state a real checkout is left in.
        assert_eq!(repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "feat/new");
        assert_eq!(repo.rev_parse("feat/new"), repo.rev_parse("main"));
        assert_eq!(repo.git(&["status", "--porcelain"]), "", "the tree must be untouched");
    }

    #[test]
    fn create_branch_at_head_refuses_an_existing_branch() {
        let repo = TestRepo::new();
        let git = Repo::open(repo.path()).expect("open");
        assert!(git.create_branch_at_head("main").is_err());
        assert_eq!(repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    }

    #[test]
    fn upstream_gone_is_false_without_an_upstream() {
        let repo = TestRepo::new();
        let git = Repo::open(repo.path()).expect("open");
        assert!(!git.upstream_gone("refs/heads/main"));
    }

    #[test]
    fn upstream_gone_detects_a_deleted_remote_branch() {
        let repo = TestRepo::new();
        repo.git(&["checkout", "--quiet", "-b", "feature"]);
        repo.commit_file("f.txt", "work");
        // What `git fetch --prune` leaves after the PR branch is deleted; the
        // remote must exist for the upstream to resolve to a ref name at all.
        repo.git(&["remote", "add", "origin", "https://example.com/x.git"]);
        repo.git(&["config", "branch.feature.remote", "origin"]);
        repo.git(&["config", "branch.feature.merge", "refs/heads/feature"]);
        let git = Repo::open(repo.path()).expect("open");
        assert!(git.upstream_gone("refs/heads/feature"));
    }

    #[test]
    fn branch_was_pushed_says_no_only_for_a_provably_local_branch() {
        let repo = TestRepo::new();
        repo.git(&["checkout", "--quiet", "-b", "feature"]);
        repo.commit_file("f.txt", "work");
        let git = Repo::open(repo.path()).expect("open");
        assert!(!git.branch_was_pushed("feature"), "no upstream, no tracking ref");

        // A branch nobody has heard of could still be a merged PR's.
        assert!(git.branch_was_pushed("never-existed"));

        repo.git(&["update-ref", "refs/remotes/origin/feature", "feature"]);
        assert!(Repo::open(repo.path()).expect("open").branch_was_pushed("feature"));
    }

    #[test]
    fn branch_was_pushed_survives_the_prune_that_follows_a_merge() {
        let repo = TestRepo::new();
        repo.git(&["checkout", "--quiet", "-b", "feature"]);
        repo.commit_file("f.txt", "work");
        repo.git(&["remote", "add", "origin", "https://example.com/x.git"]);
        repo.git(&["config", "branch.feature.remote", "origin"]);
        repo.git(&["config", "branch.feature.merge", "refs/heads/feature"]);
        let git = Repo::open(repo.path()).expect("open");
        assert!(git.branch_was_pushed("feature"));
    }
}
