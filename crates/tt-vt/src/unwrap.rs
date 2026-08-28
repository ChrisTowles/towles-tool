//! Undo the line breaks a TUI put in its own output, so a copied path or
//! command pastes as one line. libghostty already joins the terminal's *soft*
//! wraps; these are real newlines an Ink/`wrap-ansi` app emitted at its box
//! edge, indistinguishable from a hard newline in the grid.
//!
//! The tell is that the next row's first word could not have fitted on the row
//! above: that is the one thing a wrap guarantees and two separate lines do
//! not. A continuation must also sit behind a gutter, since unindented output
//! is a raw dump we must never merge.

/// One grid row as exactly `cols` characters, blanks included.
pub type Row = Vec<char>;

fn first_held(row: &Row) -> Option<usize> {
    row.iter().position(|c| *c != ' ')
}

fn last_held(row: &Row) -> Option<usize> {
    row.iter().rposition(|c| *c != ' ')
}

/// Length of the run of non-blanks starting at `at`.
fn word_at(row: &Row, at: usize) -> usize {
    row[at..].iter().take_while(|c| **c != ' ').count()
}

/// Length of the run of non-blanks ending at `at`.
fn token_to(row: &Row, at: usize) -> usize {
    row[..=at].iter().rev().take_while(|c| **c != ' ').count()
}

/// How row `a` joins the row below it, or `None` when they are separate lines.
/// A token too wide for any line was split mid-word and rejoins with nothing;
/// anything else was wrapped at a space, which the wrap consumed.
fn joiner(a: &Row, b: &Row, cols: usize) -> Option<&'static str> {
    let end = last_held(a)?;
    let gutter = first_held(b)?;
    if gutter == 0 || cols == 0 {
        return None;
    }
    // The next word fits above when it can start one blank past `end`.
    let word = word_at(b, gutter);
    if end + word + 2 <= cols {
        return None;
    }
    let content = cols.saturating_sub(2 * gutter);
    Some(if token_to(a, end) + word > content { "" } else { " " })
}

/// Rejoin `lines` wherever `rows` shows the emitter wrapped its own text.
/// `lines[i]` must be the text of `rows[i]`.
pub fn unwrap_hard_breaks(lines: &[&str], rows: &[Row], cols: u16) -> String {
    let mut out = String::new();
    for (i, line) in lines.iter().enumerate() {
        if i == 0 {
            out.push_str(line);
            continue;
        }
        match joiner(&rows[i - 1], &rows[i], cols as usize) {
            Some(sep) => {
                out.push_str(sep);
                out.push_str(line.trim_start());
            }
            None => {
                out.push('\n');
                out.push_str(line);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const COLS: u16 = 60;

    /// A row laid out like a TUI box: `indent` blanks, then `text`.
    fn row(indent: usize, text: &str) -> Row {
        let mut r: Row = vec![' '; COLS as usize];
        for (i, c) in text.chars().enumerate() {
            r[indent + i] = c;
        }
        r
    }

    fn join(rows: &[Row], lines: &[&str]) -> String {
        unwrap_hard_breaks(lines, rows, COLS)
    }

    #[test]
    fn rejoins_a_command_wrapped_at_a_space() {
        // The next row's `--registry` could not have fitted above, so the
        // break is a wrap and the space it ate comes back.
        let rows = [
            row(2, "npm install --save-dev some-package another-package"),
            row(2, "--registry https://example.com/r"),
        ];
        let text = join(
            &rows,
            &[
                "npm install --save-dev some-package another-package",
                "  --registry https://example.com/r",
            ],
        );
        assert_eq!(
            text,
            "npm install --save-dev some-package another-package --registry https://example.com/r"
        );
    }

    #[test]
    fn rejoins_a_path_split_mid_token_with_nothing() {
        let head = "/tmp/x/a-long-directory-name-for-testing-wrapping/netedxx";
        let rows = [row(2, head), row(2, "-here/a-file.txt")];
        let text = join(&rows, &[head, "  -here/a-file.txt"]);
        assert_eq!(text, format!("{head}-here/a-file.txt"));
    }

    #[test]
    fn keeps_two_separate_lines_whose_next_word_would_have_fitted() {
        let rows = [row(2, "hello"), row(2, "world")];
        assert_eq!(join(&rows, &["hello", "  world"]), "hello\n  world");
    }

    #[test]
    fn keeps_an_unindented_continuation() {
        // Column 0 means raw program output, not a box — never merge it.
        let long = "x".repeat(COLS as usize - 1);
        let rows = [row(0, &long), row(0, "another-long-token")];
        let text = join(&rows, &[&long, "another-long-token"]);
        assert_eq!(text, format!("{long}\nanother-long-token"));
    }

    #[test]
    fn joins_a_run_of_three_rows() {
        let mid = "y".repeat(COLS as usize - 2);
        let rows = [row(2, "/tmp/a/"), row(2, &mid), row(2, "/end.txt")];
        // The first row stops short, but nothing that long could have fitted.
        let text = join(&rows, &["/tmp/a/", &format!("  {mid}"), "  /end.txt"]);
        assert_eq!(text, format!("/tmp/a/{mid}/end.txt"));
    }

    #[test]
    fn a_single_line_is_returned_unchanged() {
        let rows = [row(2, "just one")];
        assert_eq!(join(&rows, &["just one"]), "just one");
    }
}
