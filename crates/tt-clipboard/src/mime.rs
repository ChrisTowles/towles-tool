//! Which of a selection's offered mime types is worth recording.

use crate::Kind;

/// Mimes that carry plain text under some name, matched case-insensitively; X11
/// bridges use the bare atoms. A served text entry offers all of them.
pub const PLAIN_TEXT: &[&str] = &[
    "text/plain;charset=utf-8",
    "text/plain",
    "UTF8_STRING",
    "STRING",
    "TEXT",
    "text/plain;charset=us-ascii",
    "text/plain;charset=unicode",
];

/// Set by password managers on a secret; such a selection is never recorded.
const PASSWORD_HINT: &str = "x-kde-passwordManagerHint";

/// The mime to receive from an offer and what it holds, or `None` to skip it:
/// plain text first, then an image (PNG preferred), then any other `text/*`.
pub fn best(offered: &[String]) -> Option<(Kind, &str)> {
    if offered.iter().any(|m| m == PASSWORD_HINT) {
        return None;
    }
    let plain =
        PLAIN_TEXT.iter().find_map(|want| offered.iter().find(|m| m.eq_ignore_ascii_case(want)));
    let image = || {
        offered
            .iter()
            .find(|m| m.eq_ignore_ascii_case("image/png"))
            .or_else(|| offered.iter().find(|m| m.starts_with("image/")))
    };
    let other_text = || offered.iter().find(|m| m.starts_with("text/"));
    let (kind, mime) = match plain {
        Some(m) => (Kind::Text, m),
        None => match image() {
            Some(m) => (Kind::Image, m),
            None => (Kind::Text, other_text()?),
        },
    };
    Some((kind, mime.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offer(mimes: &[&str]) -> Vec<String> {
        mimes.iter().map(|m| m.to_string()).collect()
    }

    #[test]
    fn plain_text_beats_everything() {
        let o = offer(&[
            "text/html",
            "image/png",
            "UTF8_STRING",
            "text/plain;charset=utf-8",
        ]);
        assert_eq!(best(&o), Some((Kind::Text, "text/plain;charset=utf-8")));
    }

    #[test]
    fn png_is_preferred_among_images() {
        let o = offer(&["text/html", "image/bmp", "image/png"]);
        assert_eq!(best(&o), Some((Kind::Image, "image/png")));
        assert_eq!(best(&offer(&["image/jpeg"])), Some((Kind::Image, "image/jpeg")));
    }

    #[test]
    fn falls_back_to_other_text() {
        assert_eq!(best(&offer(&["text/uri-list"])), Some((Kind::Text, "text/uri-list")));
        assert_eq!(best(&offer(&["application/x-thing"])), None);
    }

    #[test]
    fn password_hint_skips_the_selection() {
        assert_eq!(best(&offer(&["text/plain", PASSWORD_HINT])), None);
    }
}
