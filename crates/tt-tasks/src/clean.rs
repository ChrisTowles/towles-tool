//! Pure helpers for `tt task clean`: reading a branch's upstream-tracking
//! state, and deciding which per-checkout state directories are stale. The
//! orchestration (git calls, removal, directory sweep) lives in
//! [`crate::ops::clean_tasks`].
//!
//! Whether a task is *finished* is decided by [`crate::landed`], not here.

use std::collections::BTreeSet;

/// Whether `git for-each-ref --format=%(upstream:track)` output marks the
/// branch's upstream as deleted. Git prints exactly `[gone]` for that case
/// (`[ahead 2]`, `[behind 1]`, … otherwise; empty when there is no upstream
/// or it is in sync).
pub fn upstream_gone(track: &str) -> bool {
    track.trim() == "[gone]"
}

/// Which of the `existing` per-scope state dirs (see `tt_config::state_scope`) belong to
/// `repo` but no live checkout. Task scopes are `<repo>-<task>`, so membership is an
/// anchored `<repo>-` prefix, never a bare substring: repo `blog` must not claim
/// `blog2-thing`, and the main checkout's bare dir name must not match either. Other
/// repos' scopes and hand-forced `TT_STATE_SCOPE` names are left alone.
pub fn stale_scope_dirs(
    repo: &str,
    live_scopes: &BTreeSet<String>,
    existing: &[String],
) -> Vec<String> {
    let ours = |scope: &str| {
        scope.strip_prefix(repo).is_some_and(|rest| rest.starts_with('-') && rest.len() > 1)
    };
    let mut stale: Vec<String> = existing
        .iter()
        .filter(|scope| ours(scope) && !live_scopes.contains(*scope))
        .cloned()
        .collect();
    stale.sort();
    stale
}

/// The per-task app identifiers in `on_disk` that no live task owns. Anything that is not
/// a per-task identifier — the daily driver's base one above all — is never returned,
/// whatever `live` says.
pub fn stale_host_identifiers(on_disk: &[String], live: &BTreeSet<String>) -> Vec<String> {
    let mut stale: Vec<String> = on_disk
        .iter()
        .filter(|id| tt_config::is_per_task_identifier(id) && !live.contains(*id))
        .cloned()
        .collect();
    stale.sort();
    stale.dedup();
    stale
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_gone_parses_track_output() {
        assert!(upstream_gone("[gone]\n"));
        assert!(!upstream_gone("[ahead 2]"));
        assert!(!upstream_gone("[behind 1]"));
        assert!(!upstream_gone("")); // no upstream / in sync
        assert!(!upstream_gone("[ahead 1, behind 2]"));
    }

    #[test]
    fn stale_scopes_are_anchored_and_exclude_live() {
        let live: BTreeSet<String> = ["demo-primary".to_string(), "demo-wip".to_string()].into();
        let existing = vec![
            "demo-primary".to_string(),    // live primary — kept
            "demo-wip".to_string(),        // live task — kept
            "demo-old-merged".to_string(), // removed task — stale
            "demo2-thing".to_string(),     // another repo (anchored!) — kept
            "blog-thing".to_string(),      // another repo — kept
            "demo".to_string(),            // bare repo name, not a scope — kept
            "demo-".to_string(),           // empty task part, not a scope — kept
        ];
        assert_eq!(stale_scope_dirs("demo", &live, &existing), vec!["demo-old-merged"]);
    }

    #[test]
    fn stale_scopes_sorted() {
        let live = BTreeSet::new();
        let existing = vec!["r-b".to_string(), "r-a".to_string()];
        assert_eq!(stale_scope_dirs("r", &live, &existing), vec!["r-a", "r-b"]);
    }

    #[test]
    fn stale_host_identifiers_keep_the_base_and_the_live() {
        let live: BTreeSet<String> = tt_config::live_identifiers(["keep-me"]).into_iter().collect();
        let on_disk = vec![
            "dev.towles.tool".to_string(),
            "dev.towles.tool.task-keep-me".to_string(),
            "dev.towles.tool.slot-keep-me".to_string(),
            "dev.towles.tool.task-gone".to_string(),
            "dev.towles.tool.slot-old".to_string(),
            "dev.towles.tool.task-gone".to_string(),
            "dev.other.app".to_string(),
        ];
        assert_eq!(
            stale_host_identifiers(&on_disk, &live),
            ["dev.towles.tool.slot-old", "dev.towles.tool.task-gone"]
        );
    }

    #[test]
    fn stale_host_identifiers_never_return_the_base_even_unlisted() {
        let on_disk = vec!["dev.towles.tool".to_string()];
        assert!(stale_host_identifiers(&on_disk, &BTreeSet::new()).is_empty());
    }
}
