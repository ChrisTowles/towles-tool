//! The history: one row per distinct content, ordered by when it was last copied.
//! Re-copying something moves its row to the front instead of adding a duplicate.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::query::{Query, like_pattern};
use crate::{Error, Result, thumb};

/// Rows kept; the least recently copied beyond this are dropped on insert.
pub const MAX_ENTRIES: usize = 20_000;
/// A selection larger than this is not recorded.
pub const MAX_BYTES: usize = 64 * 1024 * 1024;
/// Characters of text a [`Summary`] carries.
const PREVIEW_CHARS: usize = 400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    Image,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Text => "text",
            Kind::Image => "image",
        }
    }

    fn parse(s: &str) -> Kind {
        if s == "image" { Kind::Image } else { Kind::Text }
    }

    /// For bytes that arrive without a mime: images are never valid UTF-8.
    pub fn sniff(data: &[u8]) -> Kind {
        if std::str::from_utf8(data).is_ok() { Kind::Text } else { Kind::Image }
    }
}

/// A row as a list shows it: no payload, and text cut to a preview.
#[derive(Debug)]
pub struct Summary {
    pub id: i64,
    pub kind: Kind,
    pub mime: String,
    pub preview: String,
    pub width: u32,
    pub height: u32,
    pub used_at: i64,
}

impl Summary {
    /// The first non-blank line of the preview, trimmed, and how many lines follow it.
    pub fn first_line(&self) -> (&str, usize) {
        let mut lines = self.preview.lines().skip_while(|l| l.trim().is_empty());
        let first = lines.next().unwrap_or("").trim();
        (first, lines.count())
    }
}

/// A row with its payload: UTF-8 for text, the encoded image otherwise.
#[derive(Debug)]
pub struct Entry {
    pub kind: Kind,
    pub mime: String,
    pub data: Vec<u8>,
}

pub struct Store {
    conn: Connection,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS entries (
    id        INTEGER PRIMARY KEY,
    hash      BLOB NOT NULL UNIQUE,
    kind      TEXT NOT NULL,
    mime      TEXT NOT NULL,
    text      TEXT,
    data      BLOB,
    thumb     BLOB,
    width     INTEGER NOT NULL DEFAULT 0,
    height    INTEGER NOT NULL DEFAULT 0,
    copied_at INTEGER NOT NULL,
    used_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_recent ON entries (used_at DESC, id DESC);
";

/// What makes two copies one entry: for text, copies differing only in
/// surrounding whitespace are the same.
fn dedup_key(kind: Kind, data: &[u8]) -> Vec<u8> {
    let content = match (kind, std::str::from_utf8(data)) {
        (Kind::Text, Ok(text)) => text.trim().as_bytes(),
        _ => data,
    };
    let mut hasher = Sha256::new();
    hasher.update(kind.as_str());
    hasher.update(content);
    hasher.finalize().to_vec()
}

impl Store {
    /// The machine's history, under [`tt_config::clipboard_dir`].
    pub fn open_default() -> Result<Store> {
        let dir = tt_config::clipboard_dir()?;
        std::fs::create_dir_all(&dir)?;
        Store::open(&dir.join("history.db"))
    }

    pub fn open(path: &Path) -> Result<Store> {
        let conn = Connection::open(path)?;
        // The watcher writes while a picker reads.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        Ok(Store { conn })
    }

    /// Record a selection; returns its row, or `None` when it is not worth keeping
    /// (blank or non-UTF-8 text, an undecodable image, too large).
    pub fn insert(&self, kind: Kind, mime: &str, data: &[u8], now_ms: i64) -> Result<Option<i64>> {
        if data.is_empty() || data.len() > MAX_BYTES {
            return Ok(None);
        }
        let text = match kind {
            Kind::Text => match std::str::from_utf8(data) {
                Ok(text) if !text.trim().is_empty() => Some(text),
                _ => return Ok(None),
            },
            Kind::Image => None,
        };
        let hash = dedup_key(kind, data);
        // A re-copy only moves to the front: no image decode, and nothing to prune.
        let bumped = self
            .conn
            .query_row(
                "UPDATE entries SET used_at = ?2, mime = ?3, text = ?4 WHERE hash = ?1 RETURNING id",
                params![hash, now_ms, mime, text],
                |r| r.get(0),
            )
            .optional()?;
        if bumped.is_some() {
            return Ok(bumped);
        }
        let (mime, data, thumb, width, height) = match kind {
            Kind::Text => (mime, None, None, 0, 0),
            Kind::Image => {
                let Some(p) = thumb::probe(data) else {
                    return Ok(None);
                };
                (p.mime, Some(data), Some(p.thumb), p.width, p.height)
            }
        };
        let id = self.conn.query_row(
            "INSERT INTO entries (hash, kind, mime, text, data, thumb, width, height, copied_at,
                                  used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
             RETURNING id",
            params![
                hash,
                kind.as_str(),
                mime,
                text,
                data,
                thumb,
                width,
                height,
                now_ms
            ],
            |r| r.get(0),
        )?;
        self.prune(MAX_ENTRIES)?;
        Ok(Some(id))
    }

    /// Run `f` as one transaction, for a bulk import.
    pub fn batch<T>(&self, f: impl FnOnce(&Store) -> Result<T>) -> Result<T> {
        let tx = self.conn.unchecked_transaction()?;
        let out = f(self)?;
        tx.commit()?;
        Ok(out)
    }

    /// Keep the `keep` most recently copied rows.
    pub fn prune(&self, keep: usize) -> Result<usize> {
        Ok(self.conn.execute(
            "DELETE FROM entries WHERE id IN
               (SELECT id FROM entries ORDER BY used_at DESC, id DESC LIMIT -1 OFFSET ?1)",
            [keep],
        )?)
    }

    /// Newest first, every term matching the text (images match only an empty term list).
    pub fn search(&self, query: &Query, limit: usize) -> Result<Vec<Summary>> {
        let mut sql = format!(
            "SELECT id, kind, mime, substr(coalesce(text, ''), 1, {PREVIEW_CHARS}), width, height,
                    used_at
             FROM entries WHERE 1 = 1"
        );
        let mut args: Vec<String> = Vec::new();
        if let Some(kind) = query.kind {
            args.push(kind.as_str().to_string());
            sql.push_str(" AND kind = ?");
        }
        for term in &query.terms {
            args.push(like_pattern(term));
            sql.push_str(" AND text LIKE ? ESCAPE '\\'");
        }
        sql.push_str(&format!(" ORDER BY used_at DESC, id DESC LIMIT {limit}"));
        let mut stmt = self.conn.prepare_cached(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(&args), |r| {
            Ok(Summary {
                id: r.get(0)?,
                kind: Kind::parse(&r.get::<_, String>(1)?),
                mime: r.get(2)?,
                preview: r.get(3)?,
                width: r.get(4)?,
                height: r.get(5)?,
                used_at: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn get(&self, id: i64) -> Result<Entry> {
        self.conn
            .query_row("SELECT kind, mime, text, data FROM entries WHERE id = ?1", [id], |r| {
                let kind = Kind::parse(&r.get::<_, String>(0)?);
                let data = match kind {
                    Kind::Text => r.get::<_, String>(2)?.into_bytes(),
                    Kind::Image => r.get(3)?,
                };
                Ok(Entry { kind, mime: r.get(1)?, data })
            })
            .optional()?
            .ok_or(Error::NotFound(id))
    }

    pub fn kind(&self, id: i64) -> Result<Kind> {
        self.conn
            .query_row("SELECT kind FROM entries WHERE id = ?1", [id], |r| {
                Ok(Kind::parse(&r.get::<_, String>(0)?))
            })
            .optional()?
            .ok_or(Error::NotFound(id))
    }

    /// The first `chars` characters of a text row, without loading the rest.
    pub fn text_prefix(&self, id: i64, chars: usize) -> Result<String> {
        self.conn
            .query_row(
                "SELECT substr(text, 1, ?2) FROM entries WHERE id = ?1",
                params![id, chars],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
            .ok_or(Error::NotFound(id))
    }

    /// The stored PNG thumbnail of an image row.
    pub fn thumb(&self, id: i64) -> Result<Option<Vec<u8>>> {
        Ok(self
            .conn
            .query_row("SELECT thumb FROM entries WHERE id = ?1", [id], |r| r.get(0))
            .optional()?
            .flatten())
    }

    pub fn delete(&self, id: i64) -> Result<bool> {
        Ok(self.conn.execute("DELETE FROM entries WHERE id = ?1", [id])? > 0)
    }

    pub fn count(&self) -> Result<usize> {
        Ok(self.conn.query_row("SELECT count(*) FROM entries", [], |r| r.get(0))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("h.db")).unwrap();
        (dir, store)
    }

    fn ids(s: &Store, q: &str) -> Vec<i64> {
        s.search(&Query::parse(q), 100).unwrap().iter().map(|e| e.id).collect()
    }

    #[test]
    fn recopying_moves_to_front_without_a_duplicate() {
        let (_d, s) = store();
        let a = s.insert(Kind::Text, "text/plain", b"alpha", 1).unwrap().unwrap();
        let b = s.insert(Kind::Text, "text/plain", b"beta", 2).unwrap().unwrap();
        assert_eq!(ids(&s, ""), [b, a]);
        assert_eq!(s.insert(Kind::Text, "UTF8_STRING", b"alpha", 3).unwrap(), Some(a));
        assert_eq!(ids(&s, ""), [a, b]);
        assert_eq!(s.count().unwrap(), 2);
    }

    #[test]
    fn surrounding_whitespace_does_not_make_a_new_entry() {
        let (_d, s) = store();
        let a = s.insert(Kind::Text, "text/plain", b"git lfs pull", 1).unwrap().unwrap();
        assert_eq!(s.insert(Kind::Text, "text/plain", b"git lfs pull\n", 2).unwrap(), Some(a));
        assert_eq!(s.get(a).unwrap().data, b"git lfs pull\n");
        assert_eq!(s.count().unwrap(), 1);
    }

    #[test]
    fn first_line_skips_leading_blanks() {
        let (_d, s) = store();
        s.insert(Kind::Text, "text/plain", b"\n  \n  hello \nworld\n!", 1).unwrap();
        let row = &s.search(&Query::default(), 1).unwrap()[0];
        assert_eq!(row.first_line(), ("hello", 2));
    }

    #[test]
    fn sniff_tells_images_from_text() {
        assert_eq!(Kind::sniff(&thumb::test_png(2, 2)), Kind::Image);
        assert_eq!(Kind::sniff(b"BM looks like a bitmap header"), Kind::Text);
    }

    #[test]
    fn skips_blank_invalid_and_undecodable() {
        let (_d, s) = store();
        assert_eq!(s.insert(Kind::Text, "text/plain", b"  \n\t", 1).unwrap(), None);
        assert_eq!(s.insert(Kind::Text, "text/plain", &[0xff, 0xfe], 1).unwrap(), None);
        assert_eq!(s.insert(Kind::Image, "image/png", b"not a png", 1).unwrap(), None);
        assert_eq!(s.count().unwrap(), 0);
    }

    #[test]
    fn images_keep_bytes_dimensions_and_a_thumbnail() {
        let (_d, s) = store();
        let png = thumb::test_png(800, 600);
        let id = s.insert(Kind::Image, "image/png", &png, 1).unwrap().unwrap();
        let e = s.get(id).unwrap();
        assert_eq!((e.kind, e.data), (Kind::Image, png));
        let sum = &s.search(&Query::parse("is:image"), 10).unwrap()[0];
        assert_eq!((sum.width, sum.height), (800, 600));
        assert!(s.thumb(id).unwrap().is_some());
    }

    #[test]
    fn search_ands_terms_case_insensitively_and_filters_kind() {
        let (_d, s) = store();
        let a = s.insert(Kind::Text, "text/plain", b"cargo test --all", 1).unwrap().unwrap();
        let b = s.insert(Kind::Text, "text/plain", b"cargo fmt", 2).unwrap().unwrap();
        let img = s.insert(Kind::Image, "image/png", &thumb::test_png(4, 4), 3).unwrap().unwrap();
        assert_eq!(ids(&s, "CARGO"), [b, a]);
        assert_eq!(ids(&s, "cargo all"), [a]);
        assert_eq!(ids(&s, "is:image"), [img]);
        assert_eq!(ids(&s, "is:text fmt"), [b]);
        assert_eq!(ids(&s, "100%"), Vec::<i64>::new());
    }

    #[test]
    fn prune_drops_the_least_recently_copied() {
        let (_d, s) = store();
        for i in 0..5 {
            s.insert(Kind::Text, "text/plain", format!("e{i}").as_bytes(), i).unwrap();
        }
        assert_eq!(s.prune(2).unwrap(), 3);
        let left: Vec<_> =
            s.search(&Query::default(), 10).unwrap().into_iter().map(|e| e.preview).collect();
        assert_eq!(left, ["e4", "e3"]);
    }
}
