//! The history: one row per distinct content, ordered by when it was last copied.
//! Re-copying something moves its row to the front instead of adding a duplicate.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::query::{Query, like_pattern};
use crate::{Error, Result, mime, thumb};

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
}

/// A row as a list shows it: no payload, and text cut to a preview.
#[derive(Debug, Clone)]
pub struct Summary {
    pub id: i64,
    pub kind: Kind,
    pub mime: String,
    pub preview: String,
    pub size: usize,
    pub width: u32,
    pub height: u32,
    pub used_at: i64,
}

/// A row with its payload: UTF-8 for text, the encoded image otherwise.
#[derive(Debug, Clone)]
pub struct Entry {
    pub id: i64,
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
    size      INTEGER NOT NULL,
    copied_at INTEGER NOT NULL,
    used_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_used_at ON entries (used_at DESC);
";

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
    /// (blank text, an undecodable image, too large).
    pub fn insert(&self, mime: &str, data: &[u8], now_ms: i64) -> Result<Option<i64>> {
        if data.is_empty() || data.len() > MAX_BYTES {
            return Ok(None);
        }
        let is_text = mime::is_plain_text(mime) || mime.starts_with("text/");
        let id = if is_text {
            let Ok(text) = std::str::from_utf8(data) else {
                return Ok(None);
            };
            if text.trim().is_empty() {
                return Ok(None);
            }
            // Copies differing only in surrounding whitespace are one entry, holding the latest.
            let key = text.trim().as_bytes();
            self.upsert(Kind::Text, mime, Some(text), None, None, (0, 0), key, now_ms)?
        } else {
            let Some(p) = thumb::probe(data) else {
                return Ok(None);
            };
            let dims = (p.width, p.height);
            self.upsert(Kind::Image, p.mime, None, Some(data), Some(&p.thumb), dims, data, now_ms)?
        };
        self.prune(MAX_ENTRIES)?;
        Ok(Some(id))
    }

    #[allow(clippy::too_many_arguments)]
    fn upsert(
        &self,
        kind: Kind,
        mime: &str,
        text: Option<&str>,
        data: Option<&[u8]>,
        thumb: Option<&[u8]>,
        (width, height): (u32, u32),
        key: &[u8],
        now_ms: i64,
    ) -> Result<i64> {
        let mut hasher = Sha256::new();
        hasher.update(kind.as_str());
        hasher.update(key);
        let size = text.map_or_else(|| data.map_or(0, <[u8]>::len), str::len);
        let hash = hasher.finalize().to_vec();
        let id = self.conn.query_row(
            "INSERT INTO entries (hash, kind, mime, text, data, thumb, width, height, size,
                                  copied_at, used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
             ON CONFLICT (hash) DO UPDATE SET used_at = excluded.used_at,
                 mime = excluded.mime, text = excluded.text, size = excluded.size
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
                size,
                now_ms
            ],
            |r| r.get(0),
        )?;
        Ok(id)
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
            "SELECT id, kind, mime, substr(coalesce(text, ''), 1, {PREVIEW_CHARS}), size, width,
                    height, used_at
             FROM entries WHERE 1 = 1"
        );
        let mut args: Vec<String> = Vec::new();
        if let Some(kind) = query.kind {
            args.push(kind.as_str().to_string());
            sql.push_str(&format!(" AND kind = ?{}", args.len()));
        }
        for term in &query.terms {
            args.push(like_pattern(term));
            sql.push_str(&format!(" AND text LIKE ?{} ESCAPE '\\'", args.len()));
        }
        sql.push_str(&format!(" ORDER BY used_at DESC, id DESC LIMIT {limit}"));
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(&args), |r| {
            Ok(Summary {
                id: r.get(0)?,
                kind: Kind::parse(&r.get::<_, String>(1)?),
                mime: r.get(2)?,
                preview: r.get(3)?,
                size: r.get(4)?,
                width: r.get(5)?,
                height: r.get(6)?,
                used_at: r.get(7)?,
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
                Ok(Entry { id, kind, mime: r.get(1)?, data })
            })
            .optional()?
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
        let a = s.insert("text/plain", b"alpha", 1).unwrap().unwrap();
        let b = s.insert("text/plain", b"beta", 2).unwrap().unwrap();
        assert_eq!(ids(&s, ""), [b, a]);
        assert_eq!(s.insert("UTF8_STRING", b"alpha", 3).unwrap(), Some(a));
        assert_eq!(ids(&s, ""), [a, b]);
        assert_eq!(s.count().unwrap(), 2);
    }

    #[test]
    fn surrounding_whitespace_does_not_make_a_new_entry() {
        let (_d, s) = store();
        let a = s.insert("text/plain", b"git lfs pull", 1).unwrap().unwrap();
        assert_eq!(s.insert("text/plain", b"git lfs pull\n", 2).unwrap(), Some(a));
        assert_eq!(s.get(a).unwrap().data, b"git lfs pull\n");
        assert_eq!(s.count().unwrap(), 1);
    }

    #[test]
    fn skips_blank_invalid_and_undecodable() {
        let (_d, s) = store();
        assert_eq!(s.insert("text/plain", b"  \n\t", 1).unwrap(), None);
        assert_eq!(s.insert("text/plain", &[0xff, 0xfe], 1).unwrap(), None);
        assert_eq!(s.insert("image/png", b"not a png", 1).unwrap(), None);
        assert_eq!(s.count().unwrap(), 0);
    }

    #[test]
    fn images_keep_bytes_dimensions_and_a_thumbnail() {
        let (_d, s) = store();
        let png = thumb::test_png(800, 600);
        let id = s.insert("image/png", &png, 1).unwrap().unwrap();
        let e = s.get(id).unwrap();
        assert_eq!((e.kind, e.data), (Kind::Image, png));
        let sum = &s.search(&Query::parse("is:image"), 10).unwrap()[0];
        assert_eq!((sum.width, sum.height), (800, 600));
        assert!(s.thumb(id).unwrap().is_some());
    }

    #[test]
    fn search_ands_terms_case_insensitively_and_filters_kind() {
        let (_d, s) = store();
        let a = s.insert("text/plain", b"cargo test --all", 1).unwrap().unwrap();
        let b = s.insert("text/plain", b"cargo fmt", 2).unwrap().unwrap();
        let img = s.insert("image/png", &thumb::test_png(4, 4), 3).unwrap().unwrap();
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
            s.insert("text/plain", format!("e{i}").as_bytes(), i).unwrap();
        }
        assert_eq!(s.prune(2).unwrap(), 3);
        let left: Vec<_> =
            s.search(&Query::default(), 10).unwrap().into_iter().map(|e| e.preview).collect();
        assert_eq!(left, ["e4", "e3"]);
    }
}
