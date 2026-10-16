use std::collections::{BTreeMap, BTreeSet};

use proptest::prelude::*;

use super::{RenderOutcome, TaskContext, TemplateError, render};
use crate::envfile;

const BASE: u16 = 3000;

fn ctx() -> TaskContext<'static> {
    TaskContext { task_name: "task-a", base_branch: "main" }
}

/// One `${tt:port A-B}` line per pool, all drawn from a narrow band so pools
/// overlap and exhaust often enough to exercise both paths.
fn any_pools() -> impl Strategy<Value = Vec<(u16, u16)>> {
    proptest::collection::vec((0u16..12, 0u16..5), 1..6)
        .prop_map(|v| v.into_iter().map(|(lo, w)| (BASE + lo, BASE + lo + w)).collect())
}

fn any_ports() -> impl Strategy<Value = BTreeSet<u16>> {
    proptest::collection::btree_set(BASE..BASE + 20, 0..10)
}

fn template(pools: &[(u16, u16)]) -> String {
    pools
        .iter()
        .enumerate()
        .map(|(i, (lo, hi))| format!("P{i}_PORT=${{tt:port {lo}-{hi}}}\n"))
        .collect()
}

fn run(
    text: &str,
    existing: &BTreeMap<String, String>,
    siblings: &BTreeSet<u16>,
    busy: &BTreeSet<u16>,
) -> Result<RenderOutcome, TemplateError> {
    render(text, &ctx(), existing, siblings, |p| !busy.contains(&p))
}

fn ports(out: &RenderOutcome) -> BTreeMap<String, u16> {
    out.claimed.iter().chain(&out.reused).cloned().collect()
}

proptest! {
    #[test]
    fn fresh_claims_respect_pool_siblings_probe_and_each_other(
        pools in any_pools(),
        siblings in any_ports(),
        busy in any_ports(),
    ) {
        let Ok(out) = run(&template(&pools), &BTreeMap::new(), &siblings, &busy) else {
            return Ok(());
        };
        prop_assert!(out.reused.is_empty());
        let got = ports(&out);
        prop_assert_eq!(got.len(), pools.len());
        let distinct: BTreeSet<u16> = got.values().copied().collect();
        prop_assert_eq!(distinct.len(), pools.len(), "two keys share a port: {:?}", got);
        let parsed: BTreeMap<String, String> = envfile::parse(&out.text).into_iter().collect();
        for (i, (lo, hi)) in pools.iter().enumerate() {
            let key = format!("P{i}_PORT");
            let port = got[&key];
            prop_assert!((*lo..=*hi).contains(&port));
            prop_assert!(!siblings.contains(&port));
            prop_assert!(!busy.contains(&port));
            prop_assert_eq!(parsed.get(&key), Some(&port.to_string()));
        }
    }

    #[test]
    fn exhaustion_means_the_pool_really_had_nothing_left(
        pools in any_pools(),
        siblings in any_ports(),
        busy in any_ports(),
    ) {
        let Err(err) = run(&template(&pools), &BTreeMap::new(), &siblings, &busy) else {
            return Ok(());
        };
        let TemplateError::PoolExhausted { line, lo, hi } = err else {
            return Err(TestCaseError::fail(format!("unexpected error {err:?}")));
        };
        let before = run(&template(&pools[..line - 1]), &BTreeMap::new(), &siblings, &busy)
            .expect("the lines before the exhausted one rendered");
        let taken: BTreeSet<u16> = ports(&before).into_values().collect();
        for p in lo..=hi {
            prop_assert!(
                siblings.contains(&p) || busy.contains(&p) || taken.contains(&p),
                "port {} was free yet line {} reported exhaustion", p, line
            );
        }
    }

    /// Re-rendering a task over its own `.env` while every port is bound (its
    /// servers are up) must keep every port, or a re-render kills the dev loop.
    #[test]
    fn rerender_is_stable_while_own_ports_are_listening(
        pools in any_pools(),
        siblings in any_ports(),
        busy in any_ports(),
    ) {
        let text = template(&pools);
        let Ok(first) = run(&text, &BTreeMap::new(), &siblings, &busy) else {
            return Ok(());
        };
        let existing: BTreeMap<String, String> = envfile::parse(&first.text).into_iter().collect();
        let all: BTreeSet<u16> = (BASE..BASE + 40).collect();
        let again = run(&text, &existing, &siblings, &all).expect("re-render reuses, never probes");
        prop_assert_eq!(&again.text, &first.text);
        prop_assert!(again.claimed.is_empty());
    }

    #[test]
    fn a_second_task_never_collides_with_the_first(
        pools in any_pools(),
        siblings in any_ports(),
    ) {
        let text = template(&pools);
        let none = BTreeSet::new();
        let Ok(first) = run(&text, &BTreeMap::new(), &siblings, &none) else {
            return Ok(());
        };
        let first_ports: BTreeSet<u16> = ports(&first).into_values().collect();
        let held: BTreeSet<u16> = siblings.union(&first_ports).copied().collect();
        // The second task inherits the first's `.env` verbatim (a copied
        // checkout), so reuse must still yield to the sibling claim.
        let inherited: BTreeMap<String, String> = envfile::parse(&first.text).into_iter().collect();
        let Ok(second) = run(&text, &inherited, &held, &none) else {
            return Ok(());
        };
        for port in ports(&second).values() {
            prop_assert!(!first_ports.contains(port), "port {} claimed twice", port);
        }
    }
}
