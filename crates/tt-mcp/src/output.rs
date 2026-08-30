//! Every tool's `outputSchema`, derived from the serde types its result is built from, so
//! the schema a client validates `structuredContent` against cannot drift from the JSON the
//! handlers emit. The wire types below exist only to be derived from: the handlers still
//! build `serde_json::Value`s, and the test helpers in `lib.rs` validate every result of
//! every test against the schema here, which is what keeps the two honest.

// Derived from, never constructed: the fields exist for `JsonSchema` alone.
#![allow(dead_code)]

use schemars::JsonSchema;
use schemars::r#gen::SchemaSettings;
use serde_json::Value;
use tt_store::{CalEvent, TaskItem};

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
struct TaskList {
    tasks: Vec<TaskItem>,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
struct OneTask {
    task: TaskItem,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "lowercase")]
enum DeleteStatus {
    Deleted,
    Refused,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
struct TaskDeleted {
    status: DeleteStatus,
    id: i64,
    text: String,
    /// Present only on a refusal; each names what blocks the delete and whether forcing
    /// past it loses work (`losesWork`).
    blockers: Option<Vec<Value>>,
    messages: Vec<String>,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "lowercase")]
enum Starting {
    Starting,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
struct TaskStarting {
    status: Starting,
    id: i64,
    text: String,
    branch: String,
}

/// Whether the pane was placed by the caller's own terminal session or by matching the path.
#[derive(JsonSchema)]
#[schemars(rename_all = "lowercase")]
enum Routed {
    Session,
    Path,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "lowercase")]
enum Showing {
    Showing,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
struct PreviewShowing {
    status: Showing,
    path: String,
    title: String,
    routed: Routed,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "lowercase")]
enum Opening {
    Opening,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
struct FileOpening {
    status: Opening,
    path: String,
    routed: Routed,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
struct CalendarToday {
    events: Vec<CalEvent>,
    now: i64,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
struct CalendarNext {
    /// `null` when nothing is scheduled; `minutesUntil` and `live` come only with an event.
    event: Option<CalEvent>,
    minutes_until: Option<i64>,
    live: Option<bool>,
    now: i64,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
struct CalendarWritten {
    source: String,
    // `i64`, not `usize`: schemars stamps unsigned integers `format: "uint64"`, which a
    // client's validator warns on at every `tools/list`; `int64` it knows. (A `///` here
    // would ship as the field's description.)
    written: i64,
    day_start: String,
    day_end: String,
}

/// The schema for `name`'s result, or `None` for a tool with no declared output.
pub fn schema_for(name: &str) -> Option<Value> {
    Some(match name {
        "task_list" => schema::<TaskList>(),
        "task_status" | "task_create" | "task_summary" => schema::<OneTask>(),
        "task_delete" => schema::<TaskDeleted>(),
        "task_start" => schema::<TaskStarting>(),
        "preview_file" => schema::<PreviewShowing>(),
        "file_open" => schema::<FileOpening>(),
        "calendar_today" => schema::<CalendarToday>(),
        "calendar_next" => schema::<CalendarNext>(),
        "calendar_set" => schema::<CalendarWritten>(),
        _ => return None,
    })
}

/// Inlined and stripped to the keywords MCP's default dialect (2020-12) reads the same way:
/// no `$ref` for a client's resolver to follow, no `$schema` naming an older draft.
fn schema<T: JsonSchema>() -> Value {
    let mut settings = SchemaSettings::draft2019_09();
    settings.inline_subschemas = true;
    let root = settings.into_generator().into_root_schema_for::<T>();
    let mut value = serde_json::to_value(root).expect("a derived schema serializes");
    if let Some(object) = value.as_object_mut() {
        object.remove("$schema");
        object.remove("title");
        object.remove("definitions");
    }
    value
}
