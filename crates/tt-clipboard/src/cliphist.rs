//! One-shot import of a [cliphist](https://github.com/sentriz/cliphist) history.

use crate::{Kind, Result, Store};

/// Entries `cliphist list` prints, newest first: `<id>\t<preview>`.
fn ids(listing: &str) -> Vec<&str> {
    listing.lines().filter_map(|l| l.split_once('\t').map(|(id, _)| id)).collect()
}

/// Copy every cliphist entry into `store`, oldest at the back. cliphist keeps no
/// times or mimes, so entries are spaced a second apart ending just before
/// `now_ms`, and each one's kind is sniffed. Returns how many were recorded.
pub fn import(store: &Store, now_ms: i64) -> Result<usize> {
    let listing = tt_exec::run("cliphist", &["list"])?;
    store.batch(|store| {
        let mut imported = 0;
        for (i, id) in ids(&listing.stdout).into_iter().enumerate() {
            let (bytes, code) = tt_exec::run_bytes("cliphist", &["decode", id])?;
            if code != 0 {
                continue;
            }
            let kind = Kind::sniff(&bytes);
            let mime = if kind == Kind::Text { "text/plain;charset=utf-8" } else { "image/png" };
            let at = now_ms - (i as i64 + 1) * 1000;
            if store.insert(kind, mime, &bytes, at)?.is_some() {
                imported += 1;
            }
        }
        Ok(imported)
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn ids_take_the_first_column() {
        let listing = "12\tsome text\n11\t[[ binary data 3 KiB png 10x10 ]]\nbogus\n";
        assert_eq!(super::ids(listing), ["12", "11"]);
    }
}
