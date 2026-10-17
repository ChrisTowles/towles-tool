use super::*;

/// The MCP contract's single source of truth, also behind the app's `mcp_tool_docs` command so
/// the MCP screen's documentation cannot drift from what the server exposes.
pub fn tool_definitions() -> Value {
    let no_args = || json!({ "type": "object", "properties": {}, "required": [] });
    let mut tools = json!([
        {
            "name": "task_list",
            "description": "Open (not-done) board tasks in board order, each with its issue/PR links and repo/worktree binding.",
            "inputSchema": no_args(),
        },
        {
            "name": "task_status",
            "description": "One board task by id — the full row (status, links, repo/worktree binding), including done tasks.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "The task's id (from task_list or task_create)." },
                },
                "required": ["id"],
            },
        },
        {
            "name": "task_create",
            "description": "Create a board task in a tracked repo's swimlane. Writes to the board.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "repo": { "type": "string", "description": "The tracked repo's GitHub `owner/repo` slug." },
                    "dir": { "type": "string", "description": "Instead of `repo`: an absolute directory inside a tracked checkout (a task worktree counts), resolving to that checkout's repo." },
                    "origin": { "type": "string", "enum": ["park"], "description": "Set only by the tt mod's /park command. Leave it out." },
                    "title": { "type": "string", "description": "The task's title." },
                    "goal": { "type": "string", "description": "Optional objective the task is meant to accomplish, shown on the board card under the title." },
                    "notes": { "type": "string", "description": "Optional free-form context." },
                    "status": { "type": "string", "enum": ["backlog", "doing", "done"], "description": "Column to land in (default backlog)." },
                },
                "required": ["title"],
            },
        },
        {
            "name": "task_summary",
            "description": "Record what you did on a task, on the task's own card — the last thing to do when the work is finished. Write the wrap-up you would otherwise print into the terminal: what landed (PR number and merge commit), what CI said, decisions worth knowing, and anything still open. The worktree and its terminal scrollback are deleted once the user confirms the task is done; the card is what survives, so this is the record they read afterwards. Replaces any previous summary for the task. Does not close the task or touch its worktree — the user confirms it is done themselves.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "The task's id (from task_list or task_status)." },
                    "summary": { "type": "string", "description": "The wrap-up, as plain text or markdown. A few short lines, not a transcript. Empty clears it." },
                },
                "required": ["id", "summary"],
            },
        },
        {
            "name": "task_sync",
            "description": "Re-read the branch a task's worktree is actually on and record it on the task. Call it after you create or switch branches inside a task's worktree (e.g. `git switch -c`), so the board card, PR auto-linking and task_list follow the new branch. Idempotent: `changed: false` means the record already matched. The worktree directory keeps its name. Refuses, with the fix in the message, a detached HEAD, the task's base branch, a worktree that is gone, or a branch another open task already records.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "The task's id (from task_list or task_status)." },
                },
                "required": ["id"],
            },
        },
        {
            "name": "task_delete",
            "description": "Close a board task and delete everything bound to it — its terminal panes and its git worktree on disk. The board row itself survives, closed with an outcome (done/abandoned) as the record of the work. Guarded: if the worktree has uncommitted changes, commits that reached no branch or remote, or a foreign process on its claimed ports, nothing is deleted and the reasons come back as `status: \"refused\"`. Report those to the user and let them decide; only pass force after they have said so explicitly, since it destroys that work permanently.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "The task's id (from task_list or task_status)." },
                    "outcome": { "type": "string", "enum": ["done", "abandoned"], "description": "How the task ended, recorded on its closed row. Omitted: inferred from the task's own evidence — done if its branch landed or a linked PR merged, else abandoned." },
                    "force": { "type": "boolean", "description": "Skip the guards and delete the worktree anyway, discarding uncommitted changes and unreachable commits for good. Default false." },
                },
                "required": ["id"],
            },
        },
        {
            "name": "task_done",
            "description": "Finish the task whose worktree you are in, as one call: the user has confirmed the work, so record your summary on its card and delete it as done — terminal panes and worktree — keeping the closed row. Finds the task from `dir`, closed cards included (a merged PR closes the card while the worktree lives on). Refuses with `status: \"refused\"` and typed `blockers`, deleting nothing, while a PR from the task's branch is still open, the worktree has uncommitted changes, or the branch has commits that reached the base through no PR. Stops the task's own dev server on its claimed ports first. It removes your own pane, so say everything before calling it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "dir": { "type": "string", "description": "Absolute path of your checkout — `git rev-parse --show-toplevel`." },
                    "summary": { "type": "string", "description": "What shipped, for the card that outlives the worktree: the PR number and merge commit, what CI said, anything still open. A few short lines." },
                },
                "required": ["dir", "summary"],
            },
        },
        {
            "name": "task_diff",
            "description": "What every other open task's checkout has changed against its base (committed and uncommitted, from the fork point), so you can spot a sibling editing the files you are. Pass `dir` to list only tasks of your repo, leave your own task out, and get `overlap`: the paths both of you changed, tasks with the most overlap first. Read-only. For a full patch, run `git diff` in the returned `dir` against `base`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "dir": { "type": "string", "description": "Absolute path of your checkout — `git rev-parse --show-toplevel`. Omitted: every open task across repos, with no overlap." },
                },
            },
        },
        {
            "name": "task_start",
            "description": "Start a board task that has no worktree yet: mint its git worktree on a fresh branch and launch a Claude session in it, working on the task's goal and notes. This is how a task goes from a card on the board to actual work in progress. Returns `status: \"starting\"` — the worktree and agent come up asynchronously in the app, so confirm with task_list rather than assuming. Refuses a task that already has a worktree (starting again would abandon the running one) or one that is closed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "The task's id (from task_list or task_status)." },
                    "branch": { "type": "string", "description": "Branch to create for the task. Omitted: derived by slugging the task's title, the same way `tt task new` does." },
                    "base": { "type": "string", "description": "Ref to branch from. Omitted: the repo's default branch." },
                },
                "required": ["id"],
            },
        },
        {
            "name": "preview_file",
            "description": "Show a file on screen in the app's Preview pane, beside the terminal you are running in — the way to hand back something worth *looking at* rather than reading as terminal output. Works for any file, artifacts included: a Markdown file renders as formatted prose, a self-contained HTML artifact renders as the page it is, and anything else (a log, a diff, JSON, source) renders as text. Good uses: a plan or design laid out for a decision, a table of what a sweep found, a before/after or diagram, a summary of a long investigation. Write the file first — anywhere you like, including a scratch directory outside the repo — then call this with its absolute path. The pane opens in *your* terminal's task: the app knows which session you are calling from, so where the file lives has no bearing on where it appears. The pane hot-reloads: it watches the file and repaints whenever you rewrite it, so you can keep editing without calling this again. An HTML artifact renders in an isolated frame with no network, so inline all CSS/JS and embed images as data: URIs — a CDN link or an external stylesheet simply won't load. Returns `status: \"showing\"`; the pane opens asynchronously, so say what you put there rather than assuming it was read.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file to show — Markdown, HTML, or any text file. Relative paths are refused — this server is shared by every session on the machine and has no working directory of its own. This names the file to render, not the task to render it in." },
                    "title": { "type": "string", "description": "Short label for the pane header, e.g. \"Migration plan\". Defaults to the file name." },
                },
                "required": ["path"],
            },
        },
        {
            "name": "file_open",
            "description": "Open a file (or folder) that already exists on disk in the app's Files pane, beside the terminal you are running in — so the human can read it without leaving the app or scrolling your output. Use it to put the thing you are talking about on screen: the file you just changed, the config you want a decision about, the test that fails. To *render* a file instead of revealing it in the tree — Markdown as prose, an HTML page you wrote as the page it is — use preview_file. The pane opens in your terminal's task; the path names the file to reveal, not the task to reveal it in, and it must be inside a folder the app tracks. Returns `status: \"opening\"` — the pane opens asynchronously, so say what you put there rather than assuming it was read.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file or directory to reveal. Relative paths are refused — this server is shared by every session on the machine and has no working directory of its own." },
                    "line": { "type": "integer", "description": "1-based line to scroll to and highlight. Ignored for a directory." },
                },
                "required": ["path"],
            },
        },
        {
            "name": "needs_you",
            "description": "Everything in this app waiting on the human, in the order their queue would work it — an agent asking, errored or finished unseen, a red CI, a review asking for changes, a PR ready to land, a landed worktree to clean up. Your own terminal is left out. Each names its checkout `dir`, `repo`, `title`, the `session` to open (null when no agent is what waits), `reason` (`unblock`, `answer`, `review`, `fix_ci`, `address_review`, `land`, `cleanup`), `why` (the same reason in the queue's words, e.g. `asking`, `CI red`, `PR approved`), any further reasons in `also`, and `sinceMs` when the wait has a start. An empty list means nothing else is on them.",
            "inputSchema": no_args(),
        },
        {
            "name": "summon",
            "description": "Get the human back when you need them to do something only they can: answer a question, approve a step, log in, plug something in. The app plays a chime every few seconds and shows one desktop notification with your `reason`, and keeps chiming until they type into *your* terminal — so end your turn with the question itself, since their answer is what stops it. Stops on its own after `max_minutes`, or if your terminal closes; calling again replaces your previous summon. Outside an app terminal (no session), input to any app terminal stops it. Don't use it for progress updates or anything that can wait — it is meant to interrupt. Returns `status: \"summoning\"` at once; it does not wait for them.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "reason": { "type": "string", "description": "What you need them to do, in one short line — shown in the notification. Truncated at 200 characters." },
                    "max_minutes": { "type": "integer", "description": "Stop chiming after this many minutes if they never answer. Default 15, clamped to 1–60." },
                },
                "required": ["reason"],
            },
        },
        {
            "name": "calendar_today",
            "description": "The shape of today: every meeting starting in today's local calendar day, in order. Use it to see where the uninterrupted stretches are before committing to deep work.",
            "inputSchema": no_args(),
        },
        {
            "name": "calendar_next",
            "description": "How much focus time is left: the meeting in progress now, or the next one to start, with `minutesUntil` (negative while a meeting is live) and a `live` flag. The one calendar read that matters mid-task — nothing scheduled means keep working.",
            "inputSchema": no_args(),
        },
        {
            "name": "calendar_set",
            "description": "Push one calendar's meetings for one local day into the local cache, replacing whatever that calendar previously had for that day. This is how the calendar gets filled — a scheduled pull writes here; nothing else reads your real calendar. Other calendars and other days are left untouched.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "source": { "type": "string", "description": "Which configured calendar this pull represents (e.g. \"google\", \"outlook\"). Only this calendar's rows for the day are replaced." },
                    "day": { "type": "string", "description": "Local calendar day being pushed, YYYY-MM-DD. Defaults to today." },
                    "events": {
                        "type": "array",
                        "description": "The meetings for that day. An empty array clears the day for this calendar.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "externalId": { "type": "string", "description": "The calendar provider's stable id for the event." },
                                "title": { "type": "string", "description": "Meeting title." },
                                "start": { "type": "string", "description": "Start time, RFC 3339 with the calendar's UTC offset, e.g. \"2026-07-20T15:00:00+01:00\" (or \"...Z\"). Keep the offset the calendar reports — it records that the meeting was booked as 3pm there, which a UTC-only time cannot." },
                                "end": { "type": "string", "description": "End time, same format. Omit for a point-in-time entry." },
                                "attendees": { "type": "array", "items": { "type": "string" }, "description": "Attendee names or addresses." },
                                "location": { "type": "string", "description": "Room or place, if any." },
                                "joinUrl": { "type": "string", "description": "Video-call link, if any." },
                            },
                            "required": ["externalId", "title", "start"],
                        },
                    },
                },
                "required": ["source", "events"],
            },
        },
        {
            "name": "inbox_take",
            "description": "For the towles-tool Claude mod only; agents never call it. Leases the notes the user sent this session from the app, so the mod can hand them to the model. Answers `pollMs: 0` outside an app terminal.",
            "inputSchema": no_args(),
        },
        {
            "name": "inbox_ack",
            "description": "For the towles-tool Claude mod only; agents never call it. Marks leased notes delivered and how.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ids": { "type": "array", "items": { "type": "integer" }, "description": "The delivered notes' ids, at most 50." },
                    "how": { "type": "string", "enum": ["midTurn", "prompt"], "description": "Read at the agent's next step, or submitted as a prompt." },
                },
                "required": ["ids", "how"],
            },
        },
        {
            "name": "next_prompt",
            "description": "For the towles-tool Claude mod only; agents never call it. Asks one context-free model question for what the user will type next, within their daily budget.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tools": { "type": "array", "items": { "type": "string" }, "description": "Tools the last turn used." },
                    "commands": { "type": "array", "items": { "type": "string" }, "description": "Bash commands the last turn ran." },
                    "answer": { "type": "string", "description": "The agent's last message." },
                    "taskId": { "type": "integer", "description": "The session's board task, for its goal." },
                },
                "required": ["tools", "commands", "answer"],
            },
        },
        {
            "name": "next_prompt_taken",
            "description": "For the towles-tool Claude mod only; agents never call it. Records that the user submitted the suggested prompt.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "edited": { "type": "boolean", "description": "Whether they changed it before sending." },
                },
                "required": ["edited"],
            },
        },
        {
            "name": "clip_suggest",
            "description": "For the towles-tool Claude mod only; agents never call it. Asks one context-free model question for which strings of the agent's last message the user would copy, within their daily budget.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "answer": { "type": "string", "description": "The agent's last message." },
                    "taskId": { "type": "integer", "description": "The session's board task, for its goal." },
                },
                "required": ["answer"],
            },
        },
        {
            "name": "clip_copied",
            "description": "For the towles-tool Claude mod only; agents never call it. Records that the user copied an offered string.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "index": { "type": "integer", "description": "Which offer, from 0; absent when all were copied." },
                    "count": { "type": "integer", "description": "How many strings went to the clipboard." },
                },
                "required": ["count"],
            },
        },
    ]);

    if let Some(entries) = tools.as_array_mut() {
        for entry in entries {
            let name = entry["name"].as_str().unwrap_or_default().to_string();
            let (_, title, effect) = TOOL_HINTS
                .iter()
                .find(|(hinted, ..)| *hinted == name)
                .unwrap_or_else(|| panic!("{name} has no TOOL_HINTS entry"));
            entry["title"] = json!(title);
            entry["annotations"] = effect.annotations(title);
            entry["outputSchema"] =
                output::schema_for(&name).unwrap_or_else(|| panic!("{name} has no output schema"));
        }
    }
    tools
}
