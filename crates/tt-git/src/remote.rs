//! Parse a git remote URL into its GitHub `owner/name` slug.

/// Normalize `git@github.com:User/Repo.git`, `https://github.com/User/Repo/` and
/// `ssh://git@github.com/User/Repo` to `host/User/Repo`, keeping the casing:
/// recording a repo's **identity** wants GitHub's own casing, since a folded copy silently becomes
/// a second, separate repo. The probes run against an `to_ascii_lowercase` copy
/// — ASCII folding is length-preserving, so its offsets index the original.
fn normalize_remote_url_preserving_case(url: &str) -> String {
    let mut s = url.trim().to_string();
    let lower = s.to_ascii_lowercase();
    // scp-like syntax: git@host:path → host/path
    if let Some(rest) = lower.strip_prefix("git@") {
        s = s[s.len() - rest.len()..].replacen(':', "/", 1);
    } else {
        // scheme://[user@]host/path → host/path
        if let Some(idx) = lower.find("://") {
            s = s[idx + 3..].to_string();
        }
        if let Some(idx) = s.find('@') {
            s = s[idx + 1..].to_string();
        }
    }
    let s = s.trim_end_matches('/');
    if s.to_ascii_lowercase().ends_with(".git") {
        s[..s.len() - 4].to_string()
    } else {
        s.to_string()
    }
}

/// `None` when fewer than two path segments remain (a bare host, a local
/// path).
fn slug_from_normalized(normalized: &str) -> Option<String> {
    let parts: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    Some(format!("{}/{}", parts[parts.len() - 2], parts[parts.len() - 1]))
}

/// The slug **keeping the remote's own casing** — the variant for recording a
/// repo's *identity*. Every other identity in the store carries the casing `gh`
/// reports and the Board groups swimlanes by that string, so folding here mints
/// a second repo identity and splits one repo across two identical lanes.
pub fn repo_slug_from_remote_preserving_case(url: &str) -> Option<String> {
    slug_from_normalized(&normalize_remote_url_preserving_case(url))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Folding the identity variant is what minted a second `christowles/...`
    /// repo alongside the `gh`-reported one and split the Board in two.
    #[test]
    fn preserving_case_slug_keeps_the_remotes_own_casing() {
        let forms = [
            "git@github.com:ChrisTowles/towles-tool.git",
            "https://github.com/ChrisTowles/towles-tool.git",
            "https://github.com/ChrisTowles/towles-tool/",
            "ssh://git@github.com/ChrisTowles/towles-tool",
            "  git@github.com:ChrisTowles/towles-tool.git\n",
        ];
        for form in forms {
            assert_eq!(
                repo_slug_from_remote_preserving_case(form).as_deref(),
                Some("ChrisTowles/towles-tool"),
                "failed for {form}"
            );
        }
    }

    #[test]
    fn preserving_case_slug_rejects_non_repo_urls() {
        assert_eq!(repo_slug_from_remote_preserving_case("github.com"), None);
        assert_eq!(repo_slug_from_remote_preserving_case(""), None);
    }
}
