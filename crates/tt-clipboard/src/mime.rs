//! Which of a selection's offered mime types is worth recording.

/// Mimes that carry plain text under some name; X11 bridges use the bare atoms.
const PLAIN_TEXT: &[&str] = &[
    "text/plain;charset=utf-8",
    "text/plain",
    "utf8_string",
    "string",
    "text",
    "text/plain;charset=us-ascii",
    "text/plain;charset=unicode",
];

/// Set by password managers on a secret; such a selection is never recorded.
const PASSWORD_HINT: &str = "x-kde-passwordManagerHint";

pub fn is_plain_text(mime: &str) -> bool {
    PLAIN_TEXT.iter().any(|m| mime.eq_ignore_ascii_case(m))
}

/// The mime to receive from an offer, or `None` to skip it: plain text first,
/// then an image (PNG preferred), then any other `text/*`.
pub fn best(offered: &[String]) -> Option<&str> {
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
    plain.or_else(image).or_else(other_text).map(String::as_str)
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
        assert_eq!(best(&o), Some("text/plain;charset=utf-8"));
    }

    #[test]
    fn png_is_preferred_among_images() {
        let o = offer(&["text/html", "image/bmp", "image/png"]);
        assert_eq!(best(&o), Some("image/png"));
        assert_eq!(best(&offer(&["image/jpeg"])), Some("image/jpeg"));
    }

    #[test]
    fn falls_back_to_other_text() {
        assert_eq!(best(&offer(&["text/uri-list"])), Some("text/uri-list"));
        assert_eq!(best(&offer(&["application/x-thing"])), None);
    }

    #[test]
    fn password_hint_skips_the_selection() {
        assert_eq!(best(&offer(&["text/plain", PASSWORD_HINT])), None);
    }
}
