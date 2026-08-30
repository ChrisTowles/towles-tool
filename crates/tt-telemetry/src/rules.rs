//! Rules: Braintrust's scorers and online scoring rules with counting in place
//! of a model. A rule's `select` filters pick a population out of the log; a
//! *share* rule scores the percentage of it that also matches `pass` and fails
//! below its threshold, a *count* rule scores the population size and fails
//! above it. Both edges are inclusive. Scoring is per UTC day (the file's day,
//! [`TelemetryRecord::day`]) so the series lines up with the log files; the
//! headline pools the newest `days` days, so with the default of one it *is*
//! the newest day's point.
//!
//! An empty population is `None`, never 0% or 100%: a day with no `gh` calls
//! says nothing about `gh`, and a rule with no evidence must not count as
//! failing — nor as passing with a green number.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::TelemetryRecord;
use crate::filter::{Filter, matches};

pub use tt_config::RuleKind;

/// The crate's own view of `tt_config::TelemetryRule`, so scoring is testable
/// without a settings file; the Tauri layer converts.
#[derive(Debug, Clone, PartialEq)]
pub struct Rule {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub kind: RuleKind,
    pub select: Vec<Filter>,
    pub pass: Vec<Filter>,
    pub threshold: f64,
    pub days: u32,
}

impl From<tt_config::TelemetryRule> for Rule {
    fn from(rule: tt_config::TelemetryRule) -> Self {
        Self {
            id: rule.id,
            label: rule.label,
            enabled: rule.enabled,
            kind: rule.kind,
            select: rule.select,
            pass: rule.pass,
            threshold: rule.threshold,
            days: rule.days,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleScore {
    pub id: String,
    pub label: String,
    pub kind: RuleKind,
    pub threshold: f64,
    /// The headline: pooled over the rule's `days` newest days, `None` when
    /// that window holds no population.
    pub today: Option<f64>,
    pub failing: bool,
    /// The headline's population.
    pub population: usize,
    /// One point per requested day, oldest first.
    pub series: Vec<DayScore>,
    /// The oldest day of the unbroken failing run ending on the newest day;
    /// days with no population neither extend nor break the run.
    pub failing_since: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayScore {
    pub day: String,
    pub score: Option<f64>,
    pub population: usize,
}

#[derive(Debug, Clone, Copy, Default)]
struct Tally {
    population: usize,
    passed: usize,
}

impl Tally {
    fn add(self, other: Tally) -> Tally {
        Tally { population: self.population + other.population, passed: self.passed + other.passed }
    }

    fn score(self, kind: RuleKind) -> Option<f64> {
        match kind {
            RuleKind::Count => Some(self.population as f64),
            RuleKind::Share => {
                (self.population > 0).then(|| self.passed as f64 / self.population as f64 * 100.0)
            }
        }
    }
}

fn fails(kind: RuleKind, threshold: f64, score: Option<f64>) -> bool {
    match (kind, score) {
        (_, None) => false,
        (RuleKind::Share, Some(share)) => share < threshold,
        (RuleKind::Count, Some(count)) => count > threshold,
    }
}

/// Every enabled rule scored over `days` (oldest first, the newest being
/// "today"); a record from a day outside the list is ignored. Disabled rules
/// are absent from the result rather than present and idle, so a failing
/// count is a plain filter over it.
pub fn score(rules: &[Rule], records: &[TelemetryRecord], days: &[String]) -> Vec<RuleScore> {
    rules.iter().filter(|rule| rule.enabled).map(|rule| score_one(rule, records, days)).collect()
}

fn score_one(rule: &Rule, records: &[TelemetryRecord], days: &[String]) -> RuleScore {
    let mut by_day: BTreeMap<&str, Tally> =
        days.iter().map(|day| (day.as_str(), Tally::default())).collect();
    for record in records {
        let Some(tally) = by_day.get_mut(record.day()) else {
            continue;
        };
        if !rule.select.iter().all(|filter| matches(record, filter)) {
            continue;
        }
        tally.population += 1;
        if rule.kind == RuleKind::Share && rule.pass.iter().all(|filter| matches(record, filter)) {
            tally.passed += 1;
        }
    }

    let series: Vec<DayScore> = days
        .iter()
        .map(|day| {
            let tally = by_day[day.as_str()];
            DayScore {
                day: day.clone(),
                score: tally.score(rule.kind),
                population: tally.population,
            }
        })
        .collect();

    let window = rule.days.max(1) as usize;
    let headline = days
        .iter()
        .rev()
        .take(window)
        .fold(Tally::default(), |acc, day| acc.add(by_day[day.as_str()]));
    let today = headline.score(rule.kind);
    let failing = fails(rule.kind, rule.threshold, today);

    RuleScore {
        id: rule.id.clone(),
        label: rule.label.clone(),
        kind: rule.kind,
        threshold: rule.threshold,
        today,
        failing,
        population: headline.population,
        failing_since: failing.then(|| failing_since(rule, &series)).flatten(),
        series,
    }
}

fn failing_since(rule: &Rule, series: &[DayScore]) -> Option<String> {
    let mut since = None;
    for day in series.iter().rev() {
        match day.score {
            None => continue,
            Some(_) if fails(rule.kind, rule.threshold, day.score) => since = Some(day.day.clone()),
            Some(_) => break,
        }
    }
    since
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FilterOp;
    use serde_json::json;

    fn record(day: &str, level: &str, name: &str, fields: serde_json::Value) -> TelemetryRecord {
        TelemetryRecord {
            ts: format!("{day}T10:00:00+00:00"),
            kind: "event".into(),
            level: level.into(),
            target: "tt_exec".into(),
            name: name.into(),
            tt_task: None,
            tt_build_sha: None,
            duration_ms: fields.get("durationMs").and_then(|v| v.as_i64()),
            pid: None,
            fields,
            raw: String::new(),
        }
    }

    fn gh(day: &str, outcome: &str) -> TelemetryRecord {
        record(
            day,
            "DEBUG",
            "process.spawn",
            json!({ "process.executable.name": "gh", "outcome": outcome }),
        )
    }

    fn warn(day: &str) -> TelemetryRecord {
        record(day, "WARN", "event x", json!({ "message": "careful" }))
    }

    fn days(list: &[&str]) -> Vec<String> {
        list.iter().map(|d| d.to_string()).collect()
    }

    fn gh_rule(threshold: f64, days: u32) -> Rule {
        Rule {
            id: "gh".into(),
            label: "gh exits clean".into(),
            enabled: true,
            kind: RuleKind::Share,
            select: vec![
                Filter::new("name", FilterOp::Eq, "process.spawn"),
                Filter::new("process.executable.name", FilterOp::Eq, "gh"),
            ],
            pass: vec![Filter::new("outcome", FilterOp::Eq, "ok")],
            threshold,
            days,
        }
    }

    fn warn_rule(threshold: f64) -> Rule {
        Rule {
            id: "zero-warn".into(),
            label: "Zero WARN".into(),
            enabled: true,
            kind: RuleKind::Count,
            select: vec![Filter::new("level", FilterOp::Eq, "WARN")],
            pass: Vec::new(),
            threshold,
            days: 1,
        }
    }

    #[test]
    fn share_rule_with_no_population_is_null_not_a_percentage() {
        let records = vec![warn("2026-08-30")];
        let scores = score(&[gh_rule(95.0, 1)], &records, &days(&["2026-08-29", "2026-08-30"]));

        assert_eq!(scores.len(), 1);
        let s = &scores[0];
        assert_eq!(s.today, None);
        assert!(!s.failing);
        assert_eq!(s.population, 0);
        assert_eq!(s.failing_since, None);
        assert!(s.series.iter().all(|d| d.score.is_none() && d.population == 0));
    }

    #[test]
    fn share_rule_scores_the_passing_fraction_and_the_edge_is_inclusive() {
        let mut records: Vec<_> = (0..19).map(|_| gh("2026-08-30", "ok")).collect();
        records.push(gh("2026-08-30", "non_zero_exit"));
        let today = days(&["2026-08-30"]);

        let exact = &score(&[gh_rule(95.0, 1)], &records, &today)[0];
        assert_eq!(exact.today, Some(95.0));
        assert_eq!(exact.population, 20);
        assert!(!exact.failing, "score == threshold passes");

        let strict = &score(&[gh_rule(96.0, 1)], &records, &today)[0];
        assert!(strict.failing);
        assert_eq!(strict.failing_since.as_deref(), Some("2026-08-30"));
    }

    #[test]
    fn count_rule_scores_the_population_and_fails_only_above_the_threshold() {
        let records = vec![
            warn("2026-08-30"),
            warn("2026-08-30"),
            gh("2026-08-30", "ok"),
        ];
        let today = days(&["2026-08-30"]);

        let at_edge = &score(&[warn_rule(2.0)], &records, &today)[0];
        assert_eq!(at_edge.today, Some(2.0));
        assert!(!at_edge.failing, "count == threshold passes");

        let over = &score(&[warn_rule(1.0)], &records, &today)[0];
        assert!(over.failing);

        // A count of zero is a real score, not missing evidence.
        let quiet = &score(&[warn_rule(0.0)], &[gh("2026-08-30", "ok")], &today)[0];
        assert_eq!(quiet.today, Some(0.0));
        assert!(!quiet.failing);
    }

    /// d1 passes, d2 fails, d3 has no gh calls, d4 and d5 fail: the run starts
    /// at d2 because the empty day neither breaks nor extends it.
    #[test]
    fn failing_since_reaches_back_across_a_gap_day_to_the_last_pass() {
        let records = vec![
            gh("2026-08-26", "ok"),
            gh("2026-08-27", "non_zero_exit"),
            warn("2026-08-28"),
            gh("2026-08-29", "non_zero_exit"),
            gh("2026-08-30", "non_zero_exit"),
        ];
        let range = days(&[
            "2026-08-26",
            "2026-08-27",
            "2026-08-28",
            "2026-08-29",
            "2026-08-30",
        ]);
        let s = &score(&[gh_rule(95.0, 1)], &records, &range)[0];

        assert!(s.failing);
        assert_eq!(s.failing_since.as_deref(), Some("2026-08-27"));
        let series: Vec<Option<f64>> = s.series.iter().map(|d| d.score).collect();
        assert_eq!(series, vec![Some(100.0), Some(0.0), None, Some(0.0), Some(0.0)]);

        // A passing day in the middle restarts the run.
        let mut recovered = records.clone();
        recovered.push(gh("2026-08-28", "ok"));
        let s = &score(&[gh_rule(95.0, 1)], &recovered, &range)[0];
        assert_eq!(s.failing_since.as_deref(), Some("2026-08-29"));
    }

    #[test]
    fn a_wider_window_pools_the_newest_days_for_the_headline() {
        let records = vec![
            gh("2026-08-28", "non_zero_exit"),
            gh("2026-08-29", "ok"),
            gh("2026-08-30", "ok"),
            gh("2026-08-30", "ok"),
        ];
        let range = days(&["2026-08-28", "2026-08-29", "2026-08-30"]);

        let two = &score(&[gh_rule(95.0, 2)], &records, &range)[0];
        assert_eq!((two.today, two.population), (Some(100.0), 3));
        let three = &score(&[gh_rule(95.0, 3)], &records, &range)[0];
        assert_eq!((three.today, three.population), (Some(75.0), 4));
        assert!(three.failing);
    }

    #[test]
    fn disabled_rules_are_skipped_and_records_outside_the_range_are_ignored() {
        let mut off = warn_rule(0.0);
        off.enabled = false;
        let records = vec![warn("2026-08-30"), warn("2026-08-01")];
        let scores = score(&[off, warn_rule(5.0)], &records, &days(&["2026-08-30"]));

        assert_eq!(scores.len(), 1);
        assert_eq!(scores[0].id, "zero-warn");
        assert_eq!(scores[0].population, 1);
    }

    #[test]
    fn wire_shape_is_camel_case_with_a_lowercase_kind() {
        let s = &score(&[warn_rule(0.0)], &[], &days(&["2026-08-30"]))[0];
        let json = serde_json::to_string(s).unwrap();
        assert!(json.contains("\"failingSince\":null"));
        assert!(json.contains("\"kind\":\"count\""));
        assert!(json.contains("\"today\":0.0"));
    }
}
