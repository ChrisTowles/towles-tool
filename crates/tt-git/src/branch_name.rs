//! Branch-name generation.

/// Lowercase, trim, anything outside `[0-9a-zA-Z_-]` to `-`, collapse runs,
/// strip trailing `-`. The character class is ASCII-only, matching the TS
/// byte-for-byte. Shared rather than re-derived: `tt-tasks`' suggestion
/// fallback and the new-task dialog's branch field both want exactly this.
pub fn slug(text: &str) -> String {
    let lowered = text.to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    for c in lowered.trim().chars() {
        let c = if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' };
        // Collapse runs of '-'.
        if c == '-' && out.ends_with('-') {
            continue;
        }
        out.push(c);
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_folds_punctuation_and_runs() {
        assert_eq!(slug("Fix bug: @user reported $100 issue!"), "fix-bug-user-reported-100-issue");
        assert_eq!(slug("  Update docs ---"), "update-docs");
        assert_eq!(slug("Fix für Übersetzung"), "fix-f-r-bersetzung");
        assert_eq!(slug("snake_case_title"), "snake_case_title");
    }
}
