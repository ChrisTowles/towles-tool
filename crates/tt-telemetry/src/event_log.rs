//! The on-disk event-log sink: append-only JSONL, one record per line,
//! rotated per UTC day.
//!
//! Per the crate's determinism rule the writer takes its directory and its
//! clock from the caller; nothing here reads `$HOME` or `SystemTime`.

use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};

/// A day's log file, kept open until the date rolls over.
struct OpenDay {
    date: String,
    writer: BufWriter<File>,
}

/// Append-only JSONL writer with per-day rotation and count-based retention.
///
/// Every write is flushed. Telemetry is read *after* something went wrong —
/// often after a crash or a `kill -9` of a wedged process — so buffering the
/// most interesting records into oblivion would defeat the purpose. Records are
pub struct EventLog {
    dir: PathBuf,
    open: Option<OpenDay>,
    /// Days of history to keep; older files are pruned on rollover.
    retain_days: usize,
}

impl EventLog {
    /// Create a log writing into `dir`, keeping `retain_days` of history.
    pub fn new(dir: impl Into<PathBuf>, retain_days: usize) -> Self {
        Self { dir: dir.into(), open: None, retain_days: retain_days.max(1) }
    }

    /// Append one already-serialized record, stamping it at `now`.
    ///
    /// Errors are deliberately swallowed into a `bool`: a telemetry sink that
    /// can propagate failure into the code it observes is worse than one that
    pub fn append(&mut self, record: &serde_json::Value, now: DateTime<Utc>) -> bool {
        let date = now.format("%Y-%m-%d").to_string();
        let Ok(line) = serde_json::to_string(record) else {
            return false;
        };
        if self.open.as_ref().is_none_or(|open| open.date != date) {
            if !self.rotate_to(&date) {
                return false;
            }
            self.prune();
        }
        let Some(open) = self.open.as_mut() else {
            return false;
        };
        writeln!(open.writer, "{line}").is_ok() && open.writer.flush().is_ok()
    }

    /// Path of the file holding `date`'s records.
    fn path_for(&self, date: &str) -> PathBuf {
        self.dir.join(format!("events-{date}.jsonl"))
    }

    /// Open (creating if needed) the file for `date`, dropping any previous
    /// handle. Returns whether the handle is usable.
    fn rotate_to(&mut self, date: &str) -> bool {
        self.open = None;
        if fs::create_dir_all(&self.dir).is_err() {
            return false;
        }
        match OpenOptions::new().create(true).append(true).open(self.path_for(date)) {
            Ok(file) => {
                self.open = Some(OpenDay { date: date.to_string(), writer: BufWriter::new(file) });
                true
            }
            Err(_) => false,
        }
    }

    fn prune(&self) {
        let _ = prune_dir(&self.dir, self.retain_days);
    }
}

/// The event-log files in `dir`, oldest first.
fn event_logs(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)?
        .flatten()
        .map(|entry| entry.path())
        .filter(|p| is_event_log(p))
        .collect();
    files.sort();
    Ok(files)
}

/// Delete all but the newest `retain_days` event-log files in `dir`, returning
/// how many went. Only our own `events-<date>.jsonl` files are ever touched.
pub fn prune_dir(dir: &Path, retain_days: usize) -> std::io::Result<usize> {
    let files = event_logs(dir)?;
    let stale = files.len().saturating_sub(retain_days.max(1));
    let mut removed = 0;
    for path in files.into_iter().take(stale) {
        if fs::remove_file(path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// What the event log occupies on disk.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStorage {
    pub files: usize,
    pub bytes: u64,
    pub oldest: Option<String>,
    pub newest: Option<String>,
}

pub fn storage(dir: &Path) -> std::io::Result<LogStorage> {
    let files = match event_logs(dir) {
        Ok(files) => files,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e),
    };
    let date = |p: Option<&PathBuf>| p.and_then(|p| event_log_date(p)).map(str::to_string);
    Ok(LogStorage {
        files: files.len(),
        bytes: files.iter().filter_map(|p| fs::metadata(p).ok()).map(|m| m.len()).sum(),
        oldest: date(files.first()),
        newest: date(files.last()),
    })
}

/// The `%Y-%m-%d` date `path` holds, if it's one of our own rotated log
/// files (`events-<date>.jsonl`) — the single place that owns this filename
/// convention, so pruning and the reader's day listing can't drift apart on
/// what counts as a log file.
pub(crate) fn event_log_date(path: &Path) -> Option<&str> {
    path.file_name()?.to_str()?.strip_prefix("events-")?.strip_suffix(".jsonl")
}

/// Whether `path` is one of our own rotated log files, so pruning can never
/// delete something else that happens to share the directory.
fn is_event_log(path: &Path) -> bool {
    event_log_date(path).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(date: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(&format!("{date}T12:00:00Z")).unwrap().with_timezone(&Utc)
    }

    fn record(msg: &str) -> serde_json::Value {
        serde_json::json!({ "message": msg })
    }

    fn lines(path: &Path) -> Vec<String> {
        fs::read_to_string(path).unwrap().lines().map(str::to_string).collect()
    }

    #[test]
    fn appends_one_json_line_per_record() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = EventLog::new(dir.path(), 7);

        assert!(log.append(&record("first"), at("2026-07-18")));
        assert!(log.append(&record("second"), at("2026-07-18")));

        let written = lines(&dir.path().join("events-2026-07-18.jsonl"));
        assert_eq!(written.len(), 2);
        let parsed: serde_json::Value = serde_json::from_str(&written[0]).unwrap();
        assert_eq!(parsed["message"], "first");
    }

    #[test]
    fn creates_the_directory_lazily_on_first_write() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("does").join("not").join("exist");
        let mut log = EventLog::new(&nested, 7);

        assert!(!nested.exists(), "constructing a log must not touch the filesystem");
        assert!(log.append(&record("hello"), at("2026-07-18")));
        assert!(nested.join("events-2026-07-18.jsonl").exists());
    }

    #[test]
    fn rolls_over_to_a_new_file_when_the_date_changes() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = EventLog::new(dir.path(), 7);

        log.append(&record("monday"), at("2026-07-18"));
        log.append(&record("tuesday"), at("2026-07-19"));

        assert_eq!(lines(&dir.path().join("events-2026-07-18.jsonl")).len(), 1);
        assert_eq!(lines(&dir.path().join("events-2026-07-19.jsonl")).len(), 1);
    }

    #[test]
    fn reopens_an_existing_day_without_truncating_it() {
        let dir = tempfile::tempdir().unwrap();

        let mut first = EventLog::new(dir.path(), 7);
        first.append(&record("before restart"), at("2026-07-18"));
        drop(first);

        let mut second = EventLog::new(dir.path(), 7);
        second.append(&record("after restart"), at("2026-07-18"));

        let written = lines(&dir.path().join("events-2026-07-18.jsonl"));
        assert_eq!(written.len(), 2, "a restart must append, not truncate");
    }

    #[test]
    fn prunes_files_beyond_the_retention_window() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = EventLog::new(dir.path(), 2);

        for day in ["2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18"] {
            log.append(&record(day), at(day));
        }

        assert!(!dir.path().join("events-2026-07-15.jsonl").exists());
        assert!(!dir.path().join("events-2026-07-16.jsonl").exists());
        assert!(dir.path().join("events-2026-07-17.jsonl").exists());
        assert!(dir.path().join("events-2026-07-18.jsonl").exists());
    }

    #[test]
    fn pruning_leaves_unrelated_files_alone() {
        let dir = tempfile::tempdir().unwrap();
        let bystander = dir.path().join("important.txt");
        fs::write(&bystander, "not ours").unwrap();

        let mut log = EventLog::new(dir.path(), 1);
        log.append(&record("a"), at("2026-07-17"));
        log.append(&record("b"), at("2026-07-18"));

        assert!(bystander.exists(), "pruning must only delete our own rotated logs");
    }

    #[test]
    fn prune_dir_keeps_the_newest_and_storage_reports_what_is_left() {
        let dir = tempfile::tempdir().unwrap();
        for date in ["2026-07-01", "2026-07-02", "2026-07-03"] {
            fs::write(dir.path().join(format!("events-{date}.jsonl")), "{}\n").unwrap();
        }
        fs::write(dir.path().join("notes.txt"), "keep me").unwrap();

        assert_eq!(prune_dir(dir.path(), 2).unwrap(), 1);
        let left = storage(dir.path()).unwrap();
        assert_eq!(left.files, 2);
        assert_eq!(left.bytes, 6);
        assert_eq!(left.oldest.as_deref(), Some("2026-07-02"));
        assert_eq!(left.newest.as_deref(), Some("2026-07-03"));
        assert!(dir.path().join("notes.txt").exists());
        assert_eq!(storage(&dir.path().join("missing")).unwrap().files, 0);
    }
}
