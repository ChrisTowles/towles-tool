use super::*;

/// Per-repo results of one collector sweep.
pub(crate) struct Sweep<T> {
    /// Includes repos with zero items, which still need their rows cleared.
    pub(crate) successes: Vec<(String, Vec<T>)>,
    pub(crate) errors: Vec<String>,
    pub(crate) skipped: Vec<String>,
}

/// Max repos swept concurrently. Modest on purpose: the win is overlapping network
/// latency, not saturating CPU.
pub(crate) const SWEEP_CONCURRENCY: usize = 4;

/// One repo's place in the sweep, tagged so results re-sort into input order.
pub(crate) enum RepoOutcome<T> {
    Skipped(String),
    Ok((String, Vec<T>)),
    Err(String),
}

/// A `reuse_ms` that ignores other windows' answers and asks GitHub directly —
/// what a manual refresh and a post-`gh pr merge` nudge both want.
pub const FETCH_NOW: i64 = 0;

/// A tracked repo dir and the GitHub repo it turned out to be.
pub(crate) struct TrackedRepo {
    pub(crate) dir: PathBuf,
    /// `owner/repo` when `gh` could name it. `None` keeps the dir in the sweep, so
    /// its error surfaces, but out of the cache, which has no key for it.
    pub(crate) name: Option<String>,
}

/// The deduped dirs alone, for callers working per *checkout*. Must stay deduped:
/// the raw tracked list would do per-repo work once per worktree.
pub(crate) fn dirs_of(repos: &[TrackedRepo]) -> Vec<PathBuf> {
    repos.iter().map(|r| r.dir.clone()).collect()
}

/// Run `collect_repo` over every repo except those another window asked GitHub about
/// under `reuse_ms` ago; see [`sweep_cache`]. `kind` names the question, so two
/// collectors can't read each other's answers.
pub(crate) fn sweep_repos_shared<T>(
    repos: &[TrackedRepo],
    kind: &str,
    reuse_ms: i64,
    now_ms: i64,
    collect_repo: impl Fn(&Path) -> Result<(String, Vec<T>), String> + Sync,
) -> Sweep<T>
where
    T: Send + serde::Serialize + serde::de::DeserializeOwned,
{
    let cache_dir = tt_config::gh_cache_dir().ok();
    // [`FETCH_NOW`] can't match, so don't look — but it still publishes below.
    let may_reuse = reuse_ms > FETCH_NOW;
    let mut reused: Vec<(String, Vec<T>)> = Vec::new();
    let mut to_fetch: Vec<PathBuf> = Vec::new();
    let mut oldest_reused_ms = 0;
    for repo in repos {
        // No name means no cache key; a gone dir must reach `sweep_repos` so the
        // run message reports the stale path rather than cached rows papering it.
        let cached = match (&cache_dir, &repo.name) {
            (Some(dir), Some(name)) if may_reuse && repo.dir.is_dir() => {
                sweep_cache::read_fresh::<T>(dir, kind, name, now_ms, reuse_ms)
                    .map(|entry| (name.clone(), entry))
            }
            _ => None,
        };
        match cached {
            Some((name, entry)) => {
                oldest_reused_ms = oldest_reused_ms.max(now_ms.saturating_sub(entry.fetched_at_ms));
                reused.push((name, entry.rows));
            }
            None => to_fetch.push(repo.dir.clone()),
        }
    }

    let mut sweep = sweep_repos(&to_fetch, collect_repo);
    if let Some(dir) = &cache_dir {
        for (name, rows) in &sweep.successes {
            sweep_cache::write(dir, kind, name, now_ms, rows);
        }
    }
    tracing::debug!(
        collector = kind,
        reused = reused.len(),
        fetched = sweep.successes.len(),
        oldest_reused_ms,
        "gh.sweep"
    );

    // Order doesn't matter: `finish_sweep` keys every row by identity.
    sweep.successes.extend(reused);
    sweep
}

/// Run `collect_repo` over every existing repo dir across a bounded thread pool.
/// Each repo's outcome is independent — one error never sinks another's rows — and
/// [`Sweep`] preserves input order, so downstream replace logic is unaffected.
pub(crate) fn sweep_repos<T: Send>(
    repo_dirs: &[PathBuf],
    collect_repo: impl Fn(&std::path::Path) -> Result<(String, Vec<T>), String> + Sync,
) -> Sweep<T> {
    let outcomes = parallel_map(repo_dirs, SWEEP_CONCURRENCY, |dir| {
        // A missing cwd makes `Command` fail with a misleading "gh not found",
        // so skip here and surface it in the run message instead.
        if !dir.is_dir() {
            return RepoOutcome::Skipped(format!("skipped missing repo dir {}", dir.display()));
        }
        match collect_repo(dir) {
            Ok(result) => RepoOutcome::Ok(result),
            Err(e) => RepoOutcome::Err(e),
        }
    });

    let mut sweep = Sweep { successes: Vec::new(), errors: Vec::new(), skipped: Vec::new() };
    for outcome in outcomes {
        match outcome {
            RepoOutcome::Skipped(msg) => sweep.skipped.push(msg),
            RepoOutcome::Ok(result) => sweep.successes.push(result),
            RepoOutcome::Err(e) => sweep.errors.push(e),
        }
    }
    sweep
}

/// Dedupe tracked dirs by resolved `owner/repo`, keeping the first seen. Every
/// worktree shares one GitHub identity, so sweeping all of them fires identical
/// queries into a budget that is per-token, not per-directory.
pub(crate) fn dedupe_repo_dirs(repo_dirs: &[PathBuf]) -> Vec<TrackedRepo> {
    let resolved = parallel_map(repo_dirs, SWEEP_CONCURRENCY, |dir| {
        (dir.clone(), gh::repo_name_with_owner(dir))
    });
    dedupe_resolved(resolved)
}

/// Pure half of [`dedupe_repo_dirs`]: first dir per resolved name, plus every dir
/// whose resolution *failed* — it can't be proven a duplicate, and its error must
/// still surface. The name travels with the dir; it is the shared cache's key.
pub(crate) fn dedupe_resolved(
    resolved: Vec<(PathBuf, Result<String, String>)>,
) -> Vec<TrackedRepo> {
    let mut seen = std::collections::HashSet::new();
    resolved
        .into_iter()
        .filter_map(|(dir, name)| match name {
            Ok(name) => seen.insert(name.clone()).then_some(TrackedRepo { dir, name: Some(name) }),
            Err(_) => Some(TrackedRepo { dir, name: None }),
        })
        .collect()
}

/// Apply `f` across up to `max_workers` scoped threads, returning results in input
/// order. A shared cursor hands each idle worker the next index, so a slow repo
/// doesn't stall the others. Panics in `f` propagate — collectors never panic.
pub(crate) fn parallel_map<In, Out>(
    items: &[In],
    max_workers: usize,
    f: impl Fn(&In) -> Out + Sync,
) -> Vec<Out>
where
    In: Sync,
    Out: Send,
{
    use std::sync::atomic::{AtomicUsize, Ordering};

    let len = items.len();
    if len == 0 {
        return Vec::new();
    }

    let next = AtomicUsize::new(0);
    let workers = max_workers.clamp(1, len);
    let f = &f;

    let mut collected: Vec<(usize, Out)> = Vec::with_capacity(len);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                scope.spawn(|| {
                    let mut local: Vec<(usize, Out)> = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        if i >= len {
                            break;
                        }
                        local.push((i, f(&items[i])));
                    }
                    local
                })
            })
            .collect();
        for handle in handles {
            collected.extend(handle.join().expect("sweep worker thread panicked"));
        }
    });

    collected.sort_by_key(|(i, _)| *i);
    collected.into_iter().map(|(_, out)| out).collect()
}

/// Apply a sweep's results and record the run. `write(all, None)` is a full-table
/// replace, `Some(repos)` a scoped one; `key_of` yields the identity that dedups
/// items collected from two checkouts of one repo.
pub(crate) fn finish_sweep<T, K: std::hash::Hash + Eq>(
    store: &Store,
    key: &str,
    sweep: Sweep<T>,
    write: impl Fn(&[T], Option<&[String]>) -> tt_store::Result<usize>,
    key_of: impl Fn(&T) -> K,
    now_ms: i64,
) -> CollectSummary {
    let Sweep { successes, errors, skipped } = sweep;

    let clean_sweep = errors.is_empty() && skipped.is_empty();
    if successes.is_empty() && !clean_sweep {
        // Repos were tracked but none answered: keep every row. No repos at all is a
        // clean sweep of nothing, which clears them.
        let notes: Vec<String> = errors.iter().cloned().chain(skipped).collect();
        return finish(store, key, errors.is_empty(), 0, Some(notes.join("; ")), now_ms);
    }
    let untracked = successes.is_empty();

    let repos: Vec<String> = successes.iter().map(|(repo, _)| repo.clone()).collect();
    let mut by_key: std::collections::HashMap<K, T> = std::collections::HashMap::new();
    for (_, items) in successes {
        for item in items {
            by_key.insert(key_of(&item), item);
        }
    }
    let all: Vec<T> = by_key.into_values().collect();
    let count = all.len();

    let scope = if clean_sweep { None } else { Some(repos.as_slice()) };
    if let Err(e) = write(&all, scope) {
        return finish(store, key, false, count, Some(e.to_string()), now_ms);
    }

    let notes: Vec<String> = errors.iter().cloned().chain(skipped).collect();
    let message = if untracked {
        Some("no repos configured".to_string())
    } else if notes.is_empty() {
        None
    } else {
        Some(notes.join("; "))
    };
    finish(store, key, errors.is_empty(), count, message, now_ms)
}
