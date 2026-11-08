//! Branch-name generation and validation.

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

/// Whether `branch` is a legal `refs/heads/<branch>`, plus a leading `-`, which is a legal
/// ref but reads as an option to every command taking a branch. The `Err` is the reason.
pub fn validate(branch: &str) -> Result<(), String> {
    if branch.starts_with('-') {
        return Err("a branch name may not begin with '-'".to_string());
    }
    gix::validate::reference::name(format!("refs/heads/{branch}").as_str().into())
        .map(|_| ())
        .map_err(|e| e.to_string())
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

    #[test]
    fn validate_accepts_legal_refs() {
        assert!(validate("feat/hello-world").is_ok());
        assert!(validate("standalone").is_ok());
    }

    #[test]
    fn validate_rejects_illegal_refs_and_a_leading_dash() {
        assert!(validate("feat/hello world").is_err());
        assert!(validate("bad..name").is_err());
        assert!(validate("-leading-dash").is_err());
    }
}
