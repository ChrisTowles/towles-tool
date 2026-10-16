//! Copy-as-Markdown: wrap a terminal selection in a fenced code block, naming
//! the language only when the text says so unambiguously.

/// `text` as a Markdown code block. The fence outgrows any backtick run inside,
/// so a selection that itself holds a fence still renders as one block.
pub fn markdown_fence(text: &str) -> String {
    let body = text.trim_end_matches(['\n', ' ']);
    let fence = "`".repeat(longest_backtick_run(body).max(2) + 1);
    format!("{fence}{}\n{body}\n{fence}\n", guess_language(body))
}

fn longest_backtick_run(text: &str) -> usize {
    text.split(|c| c != '`').map(str::len).max().unwrap_or(0)
}

/// Prompted shell, unified diff, or JSON; anything else gets no tag rather
/// than a wrong one.
fn guess_language(text: &str) -> &'static str {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let Some(first) = lines.first().map(|l| l.trim_start()) else {
        return "";
    };
    if first.starts_with("diff --git ")
        || (first.starts_with("--- ") && lines.get(1).is_some_and(|l| l.starts_with("+++ ")))
        || first.starts_with("@@ ")
    {
        return "diff";
    }
    if lines.iter().any(|l| l.trim_start().starts_with("$ ")) {
        return "console";
    }
    let trimmed = text.trim();
    let bracketed = (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'));
    if bracketed && serde_json::from_str::<serde_json::Value>(trimmed).is_ok() {
        return "json";
    }
    ""
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_gets_an_untagged_fence() {
        assert_eq!(markdown_fence("hello\nworld\n\n"), "```\nhello\nworld\n```\n");
    }

    #[test]
    fn a_prompted_command_reads_as_console() {
        assert_eq!(markdown_fence("$ ls\nREADME.md"), "```console\n$ ls\nREADME.md\n```\n");
    }

    #[test]
    fn a_unified_diff_reads_as_diff() {
        let diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b";
        assert!(markdown_fence(diff).starts_with("```diff\n"));
        assert!(markdown_fence("--- a/x\n+++ b/x\n-a").starts_with("```diff\n"));
    }

    #[test]
    fn valid_json_reads_as_json_and_lookalikes_do_not() {
        assert!(markdown_fence("{\"a\": [1, 2]}").starts_with("```json\n"));
        assert!(markdown_fence("{ not json }").starts_with("```\n"));
    }

    #[test]
    fn the_fence_outgrows_backticks_inside() {
        assert_eq!(markdown_fence("```rs\nx\n```"), "````\n```rs\nx\n```\n````\n");
    }
}
