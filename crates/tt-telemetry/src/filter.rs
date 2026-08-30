//! Structured filtering for the Log tab, run here rather than in the webview:
//! a range of days is several hundred thousand records, and only the page the
//! screen shows should cross IPC. The predicate shape ([`Filter`]) is owned by
//! `tt-config` because saved views persist it.

use serde_json::Value;

pub use tt_config::{FilterOp, TelemetryFilter as Filter};

use crate::TelemetryRecord;

/// The records matching every filter and the free-text `query` (case-insensitive
/// substring over the raw line, empty matches all), in their original order.
pub fn apply<'a>(
    records: &'a [TelemetryRecord],
    filters: &[Filter],
    query: &str,
) -> Vec<&'a TelemetryRecord> {
    let needle = query.trim().to_lowercase();
    records
        .iter()
        .filter(|record| filters.iter().all(|filter| matches(record, filter)))
        .filter(|record| needle.is_empty() || record.raw.to_lowercase().contains(&needle))
        .collect()
}

/// Whether one predicate holds for `record`. A missing field fails every
/// operator but `Neq`, which reads "is not `value`" — absent included — so
/// `outcome != ok` finds a spawn that never reached an outcome.
pub fn matches(record: &TelemetryRecord, filter: &Filter) -> bool {
    let Some(actual) = field_value(record, &filter.field) else {
        return filter.op == FilterOp::Neq;
    };
    let expected = filter.value.as_str();
    match filter.op {
        FilterOp::Eq => actual == expected,
        FilterOp::Neq => actual != expected,
        FilterOp::Contains => actual.to_lowercase().contains(&expected.to_lowercase()),
        FilterOp::Gt => compare(&actual, expected).is_gt(),
        FilterOp::Lt => compare(&actual, expected).is_lt(),
    }
}

/// Numeric when both sides parse, lexical otherwise — `durationMs > 2000` must
/// not sort `"300"` above `"2000"`.
fn compare(actual: &str, expected: &str) -> std::cmp::Ordering {
    match (actual.parse::<f64>(), expected.parse::<f64>()) {
        (Ok(a), Ok(b)) => a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal),
        _ => actual.cmp(expected),
    }
}

/// A record's value for `field` as a string: base columns by their camelCase
/// wire names (what the frontend sees), anything else looked up in `fields`.
fn field_value(record: &TelemetryRecord, field: &str) -> Option<String> {
    match field {
        "ts" => Some(record.ts.clone()),
        "kind" => Some(record.kind.clone()),
        "level" => Some(record.level.clone()),
        "target" => Some(record.target.clone()),
        "name" => Some(record.name.clone()),
        "ttTask" => record.tt_task.clone(),
        "ttBuildSha" => record.tt_build_sha.clone(),
        "durationMs" => record.duration_ms.map(|d| d.to_string()),
        "pid" => record.pid.map(|p| p.to_string()),
        other => record.fields.get(other).and_then(value_string),
    }
}

fn value_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spawn(executable: &str, duration_ms: i64, outcome: Option<&str>) -> TelemetryRecord {
        let mut fields = json!({ "process.executable.name": executable });
        if let Some(outcome) = outcome {
            fields["outcome"] = Value::from(outcome);
        }
        let raw = format!(r#"{{"name":"process.spawn","exe":"{executable}"}}"#);
        TelemetryRecord {
            ts: "2026-07-25T10:00:00+00:00".into(),
            kind: "span".into(),
            level: "DEBUG".into(),
            target: "tt_exec".into(),
            name: "process.spawn".into(),
            tt_task: Some("feat-x".into()),
            tt_build_sha: None,
            duration_ms: Some(duration_ms),
            pid: Some(7),
            fields,
            raw,
        }
    }

    fn f(field: &str, op: FilterOp, value: &str) -> Filter {
        Filter::new(field, op, value)
    }

    #[test]
    fn eq_and_neq_on_a_base_column_and_a_fields_key() {
        let r = spawn("gh", 10, Some("ok"));
        assert!(matches(&r, &f("target", FilterOp::Eq, "tt_exec")));
        assert!(!matches(&r, &f("target", FilterOp::Eq, "tt_git")));
        assert!(matches(&r, &f("process.executable.name", FilterOp::Eq, "gh")));
        assert!(matches(&r, &f("process.executable.name", FilterOp::Neq, "git")));
        assert!(!matches(&r, &f("outcome", FilterOp::Neq, "ok")));
        assert!(matches(&r, &f("ttTask", FilterOp::Eq, "feat-x")));
    }

    #[test]
    fn neq_holds_when_the_field_is_absent_but_nothing_else_does() {
        let r = spawn("gh", 10, None);
        assert!(matches(&r, &f("outcome", FilterOp::Neq, "ok")));
        assert!(!matches(&r, &f("outcome", FilterOp::Eq, "ok")));
        assert!(!matches(&r, &f("outcome", FilterOp::Contains, "o")));
        assert!(!matches(&r, &f("outcome", FilterOp::Gt, "0")));
        assert!(!matches(&r, &f("ttBuildSha", FilterOp::Eq, "abc")));
    }

    #[test]
    fn contains_is_case_insensitive() {
        let r = spawn("GitHub-CLI", 10, Some("ok"));
        assert!(matches(&r, &f("process.executable.name", FilterOp::Contains, "hub-cli")));
        assert!(matches(&r, &f("name", FilterOp::Contains, "SPAWN")));
        assert!(!matches(&r, &f("name", FilterOp::Contains, "focus")));
    }

    #[test]
    fn gt_and_lt_compare_numerically_when_both_sides_are_numbers() {
        let r = spawn("gh", 300, Some("ok"));
        // Lexically "300" > "2000"; numerically it is not.
        assert!(!matches(&r, &f("durationMs", FilterOp::Gt, "2000")));
        assert!(matches(&r, &f("durationMs", FilterOp::Lt, "2000")));
        assert!(matches(&r, &f("durationMs", FilterOp::Gt, "299.5")));
        assert!(!matches(&r, &f("durationMs", FilterOp::Gt, "300")));
    }

    #[test]
    fn gt_and_lt_fall_back_to_string_order() {
        let r = spawn("gh", 300, Some("ok"));
        assert!(matches(&r, &f("ts", FilterOp::Gt, "2026-07-25T09:59:59+00:00")));
        assert!(matches(&r, &f("ts", FilterOp::Lt, "2026-07-26")));
        assert!(!matches(&r, &f("process.executable.name", FilterOp::Gt, "git")));
    }

    #[test]
    fn non_string_field_values_compare_by_their_json_text() {
        let mut r = spawn("gh", 10, Some("ok"));
        r.fields["exit_code"] = json!(1);
        r.fields["focused"] = json!(true);
        assert!(matches(&r, &f("exit_code", FilterOp::Eq, "1")));
        assert!(matches(&r, &f("exit_code", FilterOp::Gt, "0")));
        assert!(matches(&r, &f("focused", FilterOp::Eq, "true")));
    }

    #[test]
    fn apply_ands_filters_and_searches_the_raw_line() {
        let records = vec![
            spawn("gh", 3000, Some("non_zero_exit")),
            spawn("gh", 10, Some("ok")),
            spawn("git", 5000, Some("ok")),
        ];
        let gh_failures = [
            f("process.executable.name", FilterOp::Eq, "gh"),
            f("outcome", FilterOp::Neq, "ok"),
        ];
        let hits = apply(&records, &gh_failures, "");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].duration_ms, Some(3000));

        let slow = [f("durationMs", FilterOp::Gt, "2000")];
        assert_eq!(apply(&records, &slow, "").len(), 2);
        assert_eq!(apply(&records, &slow, "GIT").len(), 1);
        assert_eq!(apply(&records, &[], "  ").len(), 3);
    }

    #[test]
    fn filter_wire_shape_matches_the_frontend() {
        let parsed: Filter =
            serde_json::from_str(r#"{"field":"durationMs","op":"gt","value":"2000"}"#).unwrap();
        assert_eq!(parsed, f("durationMs", FilterOp::Gt, "2000"));
        assert!(serde_json::from_str::<Filter>(r#"{"field":"x","op":"like","value":""}"#).is_err());
    }
}
