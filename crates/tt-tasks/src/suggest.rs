//! `claude -p`-backed branch-name/goal suggestion for the new-task dialog.
//!
//! Manual, user-triggered only (never runs on a timer or keystroke) — the
//! dialog fills its editable fields with the result and the user can still
//! edit or undo before creating the task, so this never writes anything
//! itself. Read-only by construction: the prompt tells `claude -p` not to
//! read or write repo files, just answer from the goal text and its own
//! knowledge of the repo it's pointed at (cwd = the repo checkout the dialog
//! is open for, so it has real CLAUDE.md/branch-convention context).
//!
//! The one carve-out is attached screenshots, which are named by path and
//! explicitly readable — a pasted image is frequently the entire brief, and
//! without it an image-only request yields a generic suggestion.
//!
//! The shape of the answer is the CLI's problem, not ours: `--json-schema`
//! makes `claude` route the model through a structured-output tool and hand
//! back a validated object in its `--output-format json` envelope, so there's
//! no JSON-out-of-prose extraction here. The call and the envelope handling
//! live in [`tt_exec::claude`], shared with the calendar collector — this file
//! supplies only the schema, the prompt and what counts as a usable answer.
//! Anything that still goes wrong lands on [`local_fallback`] instead of an
//! error — a "Suggest" button that can only ever fill the fields in.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Generous — a cold `claude` CLI (auth check, MCP startup) can take a while,
/// but this is a manual, one-shot user action, not a background poll.
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(60);

/// Mirrors the dialog's own `BRANCH_SLUG_SOURCE_CHARS`.
const BRANCH_SLUG_SOURCE_CHARS: usize = 50;

/// The no-Claude title fallback's length budget — short enough to read as a
/// card label, not a sentence.
const TITLE_MAX_CHARS: usize = 60;

/// JSON Schema handed to `claude -p --json-schema`, which makes the CLI itself
/// enforce the shape: the model answers through a structured-output tool and
/// the envelope carries a validated `structured_output` object. That's the
/// difference between "we asked nicely for JSON" and "the CLI guarantees it".
const SUGGESTION_SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "branch": { "type": "string", "description": "legal git ref: lowercase kebab-case, prefixed feat/, fix/, or chore/" },
    "title": { "type": "string", "description": "a short human-readable card title for the task, plain words, no slug/kebab-case" },
    "goal": { "type": "string", "description": "the rewritten task text, produced by following the caller's instruction" }
  },
  "required": ["branch", "title", "goal"],
  "additionalProperties": false
}"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Suggestion {
    pub branch: String,
    pub title: String,
    pub goal: String,
}

/// What [`suggest`] hands back: always a usable suggestion. `fallback` is
/// `Some(why)` when `claude` couldn't be reached or answered unusably and the
/// branch/goal were derived locally instead — the dialog shows that as a note,
/// not an error, because the fields still got filled with something sane.
///
/// Serializes flat (`{branch, title, goal, fallback}`) so the Tauri command can hand
/// it straight to the dialog instead of restating the fields in a parallel
/// payload type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Suggested {
    #[serde(flatten)]
    pub suggestion: Suggestion,
    pub fallback: Option<String>,
}

/// The shared structured-`claude -p` error: "never ran", "ran and errored,
/// here's the CLI's reason", "answered in the wrong shape" — kept apart so a
/// credit-balance or rate-limit failure reads as itself in the dialog's
/// fallback note.
pub type SuggestError = tt_exec::claude::Error;

pub type Result<T> = std::result::Result<T, SuggestError>;

/// Ask `claude -p` (run with cwd = `cwd`) to propose a cleaned-up goal and a
/// legal, kebab-case branch name for it.
///
/// `images` are absolute paths to screenshots the user attached (already
/// staged by [`crate::pasted`]). A screenshot is often the *whole* brief —
/// "make it look like this" with no typed goal at all — so they're named in
/// the prompt and reading them is explicitly allowed, unlike every other
/// file.
///
/// `instruction` is the **prompt improver** the user clicked (its
/// `PromptImprover::prompt` from settings): it tells the model *how* to rewrite
/// the goal — restate it plainly, turn it into a plan ask, turn it into a
/// brainstorm ask. Empty means [`DEFAULT_SUGGEST_INSTRUCTION`], the historic
/// "tidy it into one sentence" behavior. Only the `goal` is shaped by it; the
/// branch is always named for the underlying task.
///
/// Never fails while the user gave us anything to slug (see [`Suggested`]).
/// Only an image-only brief can still error, and even then the dialog's typed
/// fields are left untouched.
pub fn suggest(cwd: &Path, goal: &str, images: &[String], instruction: &str) -> Result<Suggested> {
    match ask_claude(cwd, goal, images, instruction) {
        Ok(suggestion) => Ok(Suggested { suggestion, fallback: None }),
        Err(e) => local_fallback(goal)
            .map(|suggestion| Suggested { suggestion, fallback: Some(e.brief()) })
            .ok_or(e),
    }
}

/// Ask, then hold the answer to one more rule the schema can't state: a
/// required string may still be blank, and blank fields would fill the dialog
/// with nothing. `--model sonnet` is pinned rather than left to the user's
/// `claude` config — this is a cheap one-shot call (restate/plan/brainstorm
/// the goal), not a task the user is directing, so it shouldn't silently ride
/// whatever heavier default model their CLI happens to be set to.
fn ask_claude(cwd: &Path, goal: &str, images: &[String], instruction: &str) -> Result<Suggestion> {
    let prompt = prompt_for(goal, images, instruction);
    let answer: Suggestion = tt_exec::claude::Ask::new(&prompt, SUGGESTION_SCHEMA, CLAUDE_TIMEOUT)
        .model("sonnet")
        .cwd(cwd)
        .run()?;
    usable(answer)
}

/// Trim the answer's fields and reject a blank one.
fn usable(answer: Suggestion) -> Result<Suggestion> {
    let trimmed = Suggestion {
        branch: answer.branch.trim().to_string(),
        title: answer.title.trim().to_string(),
        goal: answer.goal.trim().to_string(),
    };
    if trimmed.branch.is_empty() || trimmed.title.is_empty() || trimmed.goal.is_empty() {
        return Err(SuggestError::Unparseable("a required field came back blank".into()));
    }
    Ok(trimmed)
}

/// Derive a suggestion without `claude` at all: the goal as typed, the same
/// `feat/<slug>` the dialog's branch field already derives — same rules and
/// source-char budget, through the one shared slug helper, so the two can't
/// disagree about what the branch should be — and a plain-words title
/// truncated at a word boundary (never slugged; a title is prose, not a ref).
fn local_fallback(goal: &str) -> Option<Suggestion> {
    let goal = goal.trim();
    let slug =
        tt_git::branch_name::slug(&goal.chars().take(BRANCH_SLUG_SOURCE_CHARS).collect::<String>());
    (!slug.is_empty()).then(|| Suggestion {
        branch: format!("feat/{slug}"),
        title: truncate_title(goal),
        goal: goal.to_string(),
    })
}

/// Truncate `s` to at most [`TITLE_MAX_CHARS`] chars, cutting at the last word
/// boundary within the budget so a title never ends mid-word.
fn truncate_title(s: &str) -> String {
    if s.chars().count() <= TITLE_MAX_CHARS {
        return s.to_string();
    }
    let truncated: String = s.chars().take(TITLE_MAX_CHARS).collect();
    match truncated.rfind(' ') {
        Some(idx) if idx > 0 => truncated[..idx].to_string(),
        _ => truncated,
    }
}

fn prompt_for(goal: &str, images: &[String], instruction: &str) -> String {
    // Reading the attached screenshots is the one carve-out from the
    // otherwise blanket "touch nothing" rule: without it the model answers
    // from the goal text alone and an image-only brief yields a generic
    // suggestion. The carve-out is enumerated by path, not a general
    // permission to read the repo.
    let (image_rule, image_task) = if images.is_empty() {
        (
            "Do not read or write any files and do not run any commands — just answer \
             from the goal text and what you already know about this repository's \
             conventions."
                .to_string(),
            String::new(),
        )
    } else {
        let list = images.join(" ");
        (
            format!(
                "Read ONLY these attached image files, which describe the task: {list}. \
                 Do not read or write any other file and do not run any commands — \
                 otherwise answer from the images, the goal text, and what you already \
                 know about this repository's conventions."
            ),
            format!(
                " The attached image{} {} the task; base the goal on what {} show{}.",
                if images.len() == 1 { "" } else { "s" },
                if images.len() == 1 { "describes" } else { "describe" },
                if images.len() == 1 { "it" } else { "they" },
                if images.len() == 1 { "s" } else { "" },
            ),
        )
    };
    let goal_line = if goal.trim().is_empty() { "(no goal text — use the images)" } else { goal };
    let instruction = if instruction.trim().is_empty() {
        DEFAULT_SUGGEST_INSTRUCTION
    } else {
        instruction.trim()
    };
    format!(
        "You are naming a git branch, writing a short card title, and rewriting the \
         task goal for a new git worktree in this repository. Answer with the \
         required structured output: a `branch` like \"feat/short-kebab-slug\", a \
         `title` — a short human-readable label in plain words (not kebab-case, not \
         a slug, just how you'd say it) — and a `goal` produced by following this \
         instruction exactly:\n\n{instruction}\n\nThe branch must be a legal git ref \
         name: lowercase, kebab-case, prefixed with feat/, fix/, or chore/ as fits \
         the task — name it for the underlying task itself, never for the \
         instruction above. The title must likewise name the underlying task, never \
         the instruction above, and stay short — a few words, not a full \
         sentence.{image_task} \
         {image_rule}\n\nTask: {goal_line}"
    )
}

/// The instruction [`suggest`] uses when the caller passes none: the historic
/// "Suggest name + goal" behavior, kept as the fallback so a machine with no
/// prompt improvers configured still gets a usable rewrite.
pub const DEFAULT_SUGGEST_INSTRUCTION: &str =
    "Restate the task clearly and concisely in one sentence.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn without_images_the_prompt_forbids_touching_anything() {
        let p = prompt_for("add a thing", &[], "");
        assert!(p.contains("Do not read or write any files"));
        assert!(p.contains("Task: add a thing"));
    }

    #[test]
    fn with_images_the_prompt_names_them_and_allows_reading_only_them() {
        let images = vec!["/stage/paste-1.png".to_string()];
        let p = prompt_for("match this", &images, "");
        assert!(p.contains("/stage/paste-1.png"), "the path must be in the prompt");
        assert!(p.contains("Read ONLY these attached image files"));
        // The carve-out must stay a carve-out — still no general repo access.
        assert!(p.contains("Do not read or write any other file"));
        assert!(!p.contains("Do not read or write any files"));
    }

    #[test]
    fn an_image_only_brief_still_asks_for_a_goal() {
        // Pasting a screenshot with no typed text is a complete brief; the
        // prompt has to say so rather than sending an empty "Goal:" line that
        // reads like a mistake.
        let p = prompt_for("   ", &["/stage/paste-1.png".to_string()], "");
        assert!(p.contains("(no goal text — use the images)"));
        assert!(p.contains("base the goal on what it shows"));
    }

    #[test]
    fn several_images_read_as_plural() {
        let images = vec!["/a/paste-1.png".to_string(), "/a/paste-2.png".to_string()];
        let p = prompt_for("compare", &images, "");
        assert!(p.contains("/a/paste-1.png /a/paste-2.png"));
        assert!(p.contains("images describe the task"));
        assert!(p.contains("what they show."));
    }

    #[test]
    fn the_improver_instruction_drives_the_goal_rewrite() {
        let p = prompt_for("add dark mode", &[], "Turn this into a request for a plan.");
        assert!(p.contains("Turn this into a request for a plan."));
        // The task text stays separate from the instruction, so the model can
        // tell what to rewrite from how to rewrite it.
        assert!(p.contains("Task: add dark mode"));
        // The branch must name the task, not the instruction — otherwise every
        // "Plan" click would produce a branch called `feat/produce-a-plan`.
        assert!(p.contains("never for the instruction above"));
    }

    #[test]
    fn an_empty_instruction_falls_back_to_the_historic_behavior() {
        let p = prompt_for("add dark mode", &[], "   ");
        assert!(p.contains(DEFAULT_SUGGEST_INSTRUCTION));
    }

    #[test]
    fn the_schema_is_the_contract_for_the_three_fields() {
        // The flags that make the CLI enforce it are asserted in
        // `tt_exec::claude`; here it's the schema's own shape that matters.
        let schema: serde_json::Value = serde_json::from_str(SUGGESTION_SCHEMA).unwrap();
        assert_eq!(schema["required"], serde_json::json!(["branch", "title", "goal"]));
        assert_eq!(schema["additionalProperties"], serde_json::json!(false));
    }

    #[test]
    fn serializes_flat_for_the_dialog() {
        // The dialog reads {branch, title, goal, fallback}; `flatten` is what
        // keeps the Tauri command from needing a parallel payload struct.
        let s = Suggested {
            suggestion: Suggestion {
                branch: "feat/a".into(),
                title: "Do a".into(),
                goal: "do a".into(),
            },
            fallback: None,
        };
        let json: serde_json::Value = serde_json::to_value(&s).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"branch": "feat/a", "title": "Do a", "goal": "do a", "fallback": null})
        );
    }

    #[test]
    fn a_structured_answer_is_trimmed_field_by_field() {
        let answer = usable(Suggestion {
            branch: " feat/a ".into(),
            title: " Do a ".into(),
            goal: " do a ".into(),
        })
        .unwrap();
        assert_eq!(
            answer,
            Suggestion { branch: "feat/a".into(), title: "Do a".into(), goal: "do a".into() }
        );
    }

    #[test]
    fn blank_fields_count_as_unparseable() {
        // A schema can require a string but not require it to say anything, so
        // the blank check stays here rather than in the shared seam.
        for answer in [
            Suggestion { branch: "  ".into(), title: "x".into(), goal: "x".into() },
            Suggestion { branch: "feat/x".into(), title: "  ".into(), goal: "x".into() },
            Suggestion { branch: "feat/x".into(), title: "x".into(), goal: "  ".into() },
        ] {
            assert!(matches!(usable(answer), Err(SuggestError::Unparseable(_))));
        }
    }

    #[test]
    fn a_local_fallback_mirrors_the_dialogs_own_branch_slug() {
        let s = local_fallback("  I want All tasks: agentboard → kanban!  ").unwrap();
        assert_eq!(s.branch, "feat/i-want-all-tasks-agentboard-kanban");
        assert_eq!(s.goal, "I want All tasks: agentboard → kanban!");
        // Short goal — the title is the goal verbatim, not re-slugged.
        assert_eq!(s.title, "I want All tasks: agentboard → kanban!");
    }

    #[test]
    fn a_long_goal_only_slugs_its_opening() {
        // Counted in chars, not bytes — the budget is `chars().take(..)`, so a
        // byte-length assertion would pass on ASCII and miss a multi-byte
        // overrun entirely.
        for goal in [&"word ".repeat(40), &"wörd ".repeat(40)] {
            let s = local_fallback(goal).unwrap();
            let slug_chars = s.branch.chars().count() - "feat/".chars().count();
            assert!(slug_chars <= BRANCH_SLUG_SOURCE_CHARS, "{} ({slug_chars} chars)", s.branch);
        }
    }

    #[test]
    fn a_long_goal_truncates_the_title_at_a_word_boundary() {
        let goal = "word ".repeat(40);
        let s = local_fallback(&goal).unwrap();
        assert!(s.title.chars().count() <= TITLE_MAX_CHARS, "{:?}", s.title);
        assert!(!s.title.ends_with(' '), "{:?}", s.title);
        assert!(goal.starts_with(&s.title), "{:?}", s.title);
    }

    #[test]
    fn a_short_goal_title_is_not_truncated() {
        let s = local_fallback("fix the thing").unwrap();
        assert_eq!(s.title, "fix the thing");
    }

    #[test]
    fn a_fallback_note_stays_one_line() {
        // The note is a single 11px line in the dialog; raw stderr is not.
        // `brief` lives in the shared seam, but the dialog is what depends on
        // it, so the guarantee is asserted from here too.
        let e = SuggestError::Failed("error: boom\n  at frame one\n  at frame two".into());
        assert_eq!(e.brief(), "claude -p failed: error: boom");
    }

    #[test]
    fn nothing_to_slug_means_no_fallback() {
        // An image-only brief with no typed text: there is genuinely nothing
        // to derive, so the caller surfaces the real error instead.
        assert_eq!(local_fallback("   "), None);
        assert_eq!(local_fallback("!!!"), None);
    }
}
