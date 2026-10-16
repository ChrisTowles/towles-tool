//! Spend per checkout: each session is charged to the deepest of the given
//! directories its launch `cwd` sits in, so a task worktree nested inside its
//! repo's main checkout (`<repo>/.claude/worktrees/<name>`) keeps its own bill
//! instead of rolling up into the root's.

use std::path::Path;

use serde::Serialize;

use crate::ledger::SessionDetail;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirCost {
    pub dir: String,
    pub cost_usd: f64,
    pub sessions: usize,
    pub user_turns: i64,
}

/// One row per entry of `dirs`, in that order, zeros included. Sessions with no
/// `cwd`, or one outside every dir, are charged to none.
pub fn cost_by_dir(details: &[SessionDetail], dirs: &[String]) -> Vec<DirCost> {
    let mut rows: Vec<DirCost> = dirs
        .iter()
        .map(|dir| DirCost { dir: dir.clone(), cost_usd: 0.0, sessions: 0, user_turns: 0 })
        .collect();
    for detail in details {
        let Some(cwd) = detail.cwd.as_deref().map(Path::new) else {
            continue;
        };
        let owner = dirs
            .iter()
            .enumerate()
            .filter(|(_, dir)| cwd.starts_with(dir.as_str()))
            .max_by_key(|(_, dir)| Path::new(dir.as_str()).components().count());
        if let Some((index, _)) = owner {
            let row = &mut rows[index];
            row.cost_usd += detail.cost_usd;
            row.sessions += 1;
            row.user_turns += detail.user_turns;
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::session_detail;

    fn at(cwd: &str, cost_usd: f64) -> SessionDetail {
        SessionDetail { cwd: Some(cwd.into()), cost_usd, user_turns: 2, ..session_detail() }
    }

    #[test]
    fn charges_the_deepest_matching_checkout() {
        let dirs = vec![
            "/r".to_string(),
            "/r/.claude/worktrees/a".to_string(),
            "/s".to_string(),
        ];
        let details = vec![
            at("/r", 1.0),
            at("/r/crates/x", 0.5),
            at("/r/.claude/worktrees/a", 2.0),
            at("/r/.claude/worktrees/a/apps", 0.25),
            at("/rx", 9.0),
            SessionDetail { cwd: None, cost_usd: 9.0, ..session_detail() },
        ];

        let rows = cost_by_dir(&details, &dirs);
        let costs: Vec<(f64, usize, i64)> =
            rows.iter().map(|r| (r.cost_usd, r.sessions, r.user_turns)).collect();
        assert_eq!(costs, vec![(1.5, 2, 4), (2.25, 2, 4), (0.0, 0, 0)]);
    }
}
