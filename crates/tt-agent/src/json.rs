//! Tolerant field readers for the two wire protocols on the CLI's pipe.
//!
//! Both [`crate::protocol`] and [`crate::control`] read the same kind of
//! loosely-typed JSON, so these live in neither of them: the message-stream
//! parser was the incidental home only because it needed them first, and a
//! parser that doubles as the crate's utility bag is how the seam blurs.
//!
//! The shared trait is *tolerance*. A missing or wrong-typed field yields a
//! default rather than an error, because a line the CLI sent is a line we have
//! to render (or answer) regardless of how sparse it is.

use serde_json::Value;

/// A string field, or `""` when absent or not a string.
pub(crate) fn str_field(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// A string field, with empty collapsed to `None`.
pub(crate) fn opt_str_field(v: &Value, key: &str) -> Option<String> {
    // An empty string is how the CLI spells "no hint" for `argumentHint`;
    // collapsing it to `None` keeps that out of the UI as a stray label.
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_and_mistyped_fields_fall_back_rather_than_failing() {
        let v = json!({ "a": "x", "n": 7, "empty": "" });
        assert_eq!(str_field(&v, "a"), "x");
        assert_eq!(str_field(&v, "absent"), "");
        // A number where a string was expected is still not an error.
        assert_eq!(str_field(&v, "n"), "");
        assert_eq!(opt_str_field(&v, "a").as_deref(), Some("x"));
        assert_eq!(opt_str_field(&v, "absent"), None);
        // "" means "nothing to say", not a value worth rendering.
        assert_eq!(opt_str_field(&v, "empty"), None);
    }
}
