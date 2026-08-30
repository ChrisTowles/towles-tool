//! SQL over the event log — the "next incident is a jq query" promise in
//! docs/TELEMETRY.md, answered inside the app. A fortnight of
//! `events-<date>.jsonl` becomes an in-memory SQLite `records` table (one row
//! per line; the long tail of per-record fields stays a JSON column for
//! `json_extract`) plus a `spans` view promoting the `process.spawn`
//! attributes to real columns. Two identity rules the schema bakes in: an
//! *event* is named by its `message` (its `name` is the throwaway
//! `event <file>:<line>`), and `day` is the UTC file date. Only one read-only
//! `SELECT`/`WITH` may run — the tables are a projection of the files, so a
//! write could only corrupt the answer, never the log.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use rusqlite::types::ValueRef;
use rusqlite::{Connection, ErrorCode, Statement, params};
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;

use crate::TelemetryRecord;

/// Rows a result may carry; past this `truncated` is set and the rest dropped.
pub const ROW_CAP: usize = 2_000;

/// A statement still running after this is interrupted.
pub const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Error)]
pub enum QueryError {
    #[error("Only a single SELECT or WITH statement can run here")]
    NotReadOnly,

    #[error("One statement at a time — remove everything after the first `;`")]
    MultipleStatements,

    #[error("Stopped after {}s — narrow the query", TIMEOUT.as_secs())]
    Interrupted,

    #[error("{0}")]
    Sqlite(rusqlite::Error),
}

impl QueryError {
    /// A stable word for the `outcome` field of the `telemetry.query_ran` event.
    pub fn outcome(&self) -> &'static str {
        match self {
            Self::NotReadOnly => "not_read_only",
            Self::MultipleStatements => "multiple_statements",
            Self::Interrupted => "interrupted",
            Self::Sqlite(_) => "sqlite_error",
        }
    }
}

impl From<rusqlite::Error> for QueryError {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::SqliteFailure(f, _) if f.code == ErrorCode::OperationInterrupted => {
                Self::Interrupted
            }
            e => Self::Sqlite(e),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

/// The in-memory database: `records`, the `spans` view, and nothing else.
pub struct EventDb {
    conn: Connection,
    record_count: usize,
}

const SCHEMA: &str = "
CREATE TABLE records (
    ts TEXT NOT NULL,
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    level TEXT NOT NULL,
    target TEXT NOT NULL,
    name TEXT NOT NULL,
    message TEXT,
    duration_ms INTEGER,
    tt_task TEXT,
    build_sha TEXT,
    fields TEXT NOT NULL
);
CREATE VIEW spans AS
    SELECT *,
        json_extract(fields, '$.\"process.executable.name\"') AS executable,
        json_extract(fields, '$.\"process.command_args\"') AS command_args,
        json_extract(fields, '$.\"process.working_directory\"') AS working_directory,
        json_extract(fields, '$.outcome') AS outcome,
        json_extract(fields, '$.exit_code') AS exit_code
    FROM records
    WHERE kind = 'span';
";

// Built after the bulk insert, which is cheaper than maintaining them through
// it. `(day, name)` serves spans, `(message, ts)` serves events — the two
// identity columns — and `query_only` makes the read-only rule SQLite's own.
const AFTER_LOAD: &str = "
CREATE INDEX records_day_name ON records (day, name);
CREATE INDEX records_message_ts ON records (message, ts);
PRAGMA query_only = ON;
";

impl EventDb {
    pub fn build(records: &[TelemetryRecord]) -> Result<Self, QueryError> {
        let mut conn = Connection::open_in_memory()?;
        conn.busy_timeout(TIMEOUT)?;
        conn.execute_batch(SCHEMA)?;
        let tx = conn.transaction()?;
        {
            let mut insert = tx.prepare(
                "INSERT INTO records VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )?;
            for r in records {
                let message = r.fields.get("message").and_then(Value::as_str);
                insert.execute(params![
                    r.ts,
                    r.day(),
                    r.kind,
                    r.level,
                    r.target,
                    r.name,
                    message,
                    r.duration_ms,
                    r.tt_task,
                    r.tt_build_sha,
                    r.fields.to_string(),
                ])?;
            }
        }
        tx.commit()?;
        conn.execute_batch(AFTER_LOAD)?;
        Ok(Self { conn, record_count: records.len() })
    }

    pub fn record_count(&self) -> usize {
        self.record_count
    }
}

/// Runs one read-only statement and collects up to `row_cap` rows as JSON
/// values (text, integer, real, null; a blob is described, not shipped).
pub fn run(db: &EventDb, sql: &str, row_cap: usize) -> Result<QueryResult, QueryError> {
    check_single_select(sql)?;
    let started = Instant::now();
    let mut stmt = db.conn.prepare(sql)?;
    if !stmt.readonly() {
        return Err(QueryError::NotReadOnly);
    }
    let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();

    // The watchdog waits on a channel the query side drops when it finishes;
    // only a *timeout* interrupts, so a query that ends first leaves the
    // connection alone. Scoped, so the thread is joined before we return.
    let handle = db.conn.get_interrupt_handle();
    let (done, wait) = mpsc::channel::<()>();
    let (rows, truncated) = std::thread::scope(|scope| {
        scope.spawn(move || {
            if wait.recv_timeout(TIMEOUT) == Err(RecvTimeoutError::Timeout) {
                handle.interrupt();
            }
        });
        let collected = collect_rows(&mut stmt, columns.len(), row_cap);
        drop(done);
        collected
    })?;

    Ok(QueryResult {
        columns,
        rows,
        truncated,
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

fn collect_rows(
    stmt: &mut Statement<'_>,
    width: usize,
    row_cap: usize,
) -> rusqlite::Result<(Vec<Vec<Value>>, bool)> {
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        if out.len() == row_cap {
            return Ok((out, true));
        }
        let cells = (0..width)
            .map(|i| row.get_ref(i).map(to_json))
            .collect::<rusqlite::Result<Vec<Value>>>()?;
        out.push(cells);
    }
    Ok((out, false))
}

fn to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(bytes) => Value::from(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => Value::from(format!("<blob {} bytes>", bytes.len())),
    }
}

/// `prepare` compiles only the first statement, so `select 1; delete from
/// records` would pass the read-only check on the `select` — hence the split
/// on `;` (with comments and literals blanked so a `;` inside one doesn't
/// count). The first-word check exists because SQLite calls `BEGIN` and
/// `PRAGMA` read-only too.
fn check_single_select(sql: &str) -> Result<(), QueryError> {
    let bare = blank_comments_and_literals(sql);
    let mut statements = bare.split(';');
    let first = statements.next().unwrap_or_default();
    if statements.any(|rest| !rest.trim().is_empty()) {
        return Err(QueryError::MultipleStatements);
    }
    let keyword = first.split_whitespace().next().unwrap_or_default().to_ascii_uppercase();
    match keyword.as_str() {
        "SELECT" | "WITH" => Ok(()),
        _ => Err(QueryError::NotReadOnly),
    }
}

fn blank_comments_and_literals(sql: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match c {
            '-' if next == Some('-') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if next == Some('*') => {
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i += 2;
            }
            '\'' | '"' | '`' => {
                i += 1;
                loop {
                    while i < chars.len() && chars[i] != c {
                        i += 1;
                    }
                    i += 1;
                    // A doubled quote is an escaped one, not the end.
                    if i < chars.len() && chars[i] == c {
                        i += 1;
                        continue;
                    }
                    break;
                }
            }
            '[' => {
                while i < chars.len() && chars[i] != ']' {
                    i += 1;
                }
                i += 1;
            }
            _ => {
                out.push(c);
                i += 1;
                continue;
            }
        }
        out.push(' ');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{read_days, recent_days};

    const LINES: &[(&str, &str)] = &[
        (
            "2026-08-29",
            r#"{"ts":"2026-08-29T23:59:59.123456789+00:00","kind":"span","level":"DEBUG","target":"tt_exec","name":"process.spawn","duration_ms":2500,"exit_code":1,"outcome":"non_zero_exit","process.executable.name":"gh","process.command_args":"pr list","process.working_directory":"/w/a","tt.task":"feat-x","tt.build_sha":"abc"}"#,
        ),
        (
            "2026-08-30",
            r#"{"ts":"2026-08-30T10:00:00+00:00","kind":"span","level":"DEBUG","target":"tt_exec","name":"process.spawn","duration_ms":12,"exit_code":0,"outcome":"ok","process.executable.name":"git","process.command_args":"status","process.working_directory":"/w/a"}"#,
        ),
        (
            "2026-08-30",
            r#"{"ts":"2026-08-30T10:00:01+00:00","kind":"event","level":"INFO","target":"tt_app_lib","name":"event crates-tauri/tt-app/src/lib.rs:646","message":"window.focus_changed","focused":true,"window":"main"}"#,
        ),
        (
            "2026-08-30",
            r#"{"ts":"2026-08-30T10:00:02+00:00","kind":"event","level":"INFO","target":"tt_app_lib::agentboard","name":"event crates-tauri/tt-app/src/agentboard.rs:158","message":"notify_needs_you: fired","reason":"Finished","repo":"monorepo","session":"shell 17"}"#,
        ),
        (
            "2026-08-30",
            r#"{"ts":"2026-08-30T10:00:03+00:00","kind":"event","level":"INFO","target":"tt_app_lib","name":"event crates-tauri/tt-app/src/lib.rs:85","message":"ui.action","action":"mouse.ab-new-session","screen":"agentboard"}"#,
        ),
    ];

    fn fixture_db() -> EventDb {
        let dir = tempfile::tempdir().unwrap();
        for (day, line) in LINES {
            let path = dir.path().join(format!("events-{day}.jsonl"));
            let mut content = std::fs::read_to_string(&path).unwrap_or_default();
            content.push_str(line);
            content.push('\n');
            std::fs::write(path, content).unwrap();
        }
        let days = recent_days(dir.path(), 14).unwrap();
        EventDb::build(&read_days(dir.path(), &days).unwrap()).unwrap()
    }

    fn cell(result: &QueryResult, row: usize, col: usize) -> &Value {
        &result.rows[row][col]
    }

    #[test]
    fn builds_records_and_spans_from_fixture_lines() {
        let db = fixture_db();
        assert_eq!(db.record_count(), LINES.len());

        let r = run(&db, "select count(*), min(day), max(day) from records", ROW_CAP).unwrap();
        assert_eq!(
            r.rows,
            vec![vec![
                Value::from(5),
                "2026-08-29".into(),
                "2026-08-30".into()
            ]]
        );

        let r = run(
            &db,
            "select executable, outcome, exit_code, working_directory, tt_task \
             from spans where duration_ms > 2000",
            ROW_CAP,
        )
        .unwrap();
        assert_eq!(
            r.columns,
            [
                "executable",
                "outcome",
                "exit_code",
                "working_directory",
                "tt_task"
            ]
        );
        assert_eq!(
            r.rows,
            vec![vec![
                "gh".into(),
                "non_zero_exit".into(),
                Value::from(1),
                "/w/a".into(),
                "feat-x".into()
            ]]
        );

        // An event's identity is its message, never its `event <file>:<line>` name.
        let r =
            run(&db, "select count(*) from records where message = 'ui.action'", ROW_CAP).unwrap();
        assert_eq!(cell(&r, 0, 0), &Value::from(1));
        assert!(!r.truncated);
    }

    #[test]
    fn json_extract_reaches_the_long_tail() {
        let db = fixture_db();
        let r = run(
            &db,
            "select json_extract(fields, '$.reason') from records \
             where message like 'notify_needs_you%'",
            ROW_CAP,
        )
        .unwrap();
        assert_eq!(cell(&r, 0, 0), "Finished");
    }

    #[test]
    fn nanosecond_timestamps_work_with_the_date_functions() {
        // The writer emits nine fractional digits and a `+00:00` suffix; the
        // default queries bucket by `strftime`, so SQLite must parse that.
        let db = fixture_db();
        let r =
            run(&db, "select strftime('%H:%M', ts) from records where day = '2026-08-29'", ROW_CAP)
                .unwrap();
        assert_eq!(cell(&r, 0, 0), "23:59");
    }

    #[test]
    fn row_cap_marks_truncation() {
        let db = fixture_db();
        let r = run(&db, "select ts from records order by ts", 2).unwrap();
        assert_eq!(r.rows.len(), 2);
        assert!(r.truncated);
        let r = run(&db, "select ts from records order by ts", 5).unwrap();
        assert_eq!(r.rows.len(), 5);
        assert!(!r.truncated);
    }

    #[test]
    fn rejects_writes_and_non_selects() {
        let db = fixture_db();
        for sql in [
            "delete from records",
            "drop table records",
            "insert into records (ts) values ('x')",
            "pragma table_info(records)",
            "begin",
            "",
        ] {
            assert!(matches!(run(&db, sql, ROW_CAP), Err(QueryError::NotReadOnly)), "{sql:?}");
        }
        // Belt and braces: even a statement that slipped past the keyword
        // check can't write, because the connection is `query_only`.
        assert!(db.conn.execute("delete from records", []).is_err());
    }

    #[test]
    fn rejects_multiple_statements_but_not_a_trailing_semicolon() {
        let db = fixture_db();
        for sql in [
            "select 1; select 2",
            "select 1; delete from records",
            "select 1;\n-- note\ndrop table records",
        ] {
            assert!(
                matches!(run(&db, sql, ROW_CAP), Err(QueryError::MultipleStatements)),
                "{sql:?}"
            );
        }
        for sql in [
            "select 1;",
            "select 1; -- ; a comment",
            "select ';' as semi /* ; */",
            "select 'it''s; fine' as s",
            "with t as (select 1 as n) select n from t;",
        ] {
            assert!(run(&db, sql, ROW_CAP).is_ok(), "{sql:?}");
        }
    }

    #[test]
    fn sqlite_errors_carry_the_message() {
        let db = fixture_db();
        let err = run(&db, "select nope from records", ROW_CAP).unwrap_err();
        assert_eq!(err.outcome(), "sqlite_error");
        assert!(err.to_string().contains("no such column"), "{err}");
    }

    #[test]
    fn every_default_saved_query_runs() {
        let db = fixture_db();
        for q in tt_config::SavedQuery::defaults() {
            let r = run(&db, &q.sql, ROW_CAP).unwrap_or_else(|e| panic!("{}: {e}", q.label));
            assert!(!r.columns.is_empty(), "{}", q.label);
        }
    }

    #[test]
    fn interruptions_while_focused_finds_the_fixture_notification() {
        let db = fixture_db();
        let q = tt_config::SavedQuery::defaults()
            .into_iter()
            .find(|q| q.id == "interruptions-while-focused")
            .unwrap();
        let r = run(&db, &q.sql, ROW_CAP).unwrap();
        assert_eq!(r.rows.len(), 1, "{:?}", r.rows);
    }
}
