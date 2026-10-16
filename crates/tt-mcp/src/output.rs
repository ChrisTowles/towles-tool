//! Every tool's `outputSchema`, derived from the serde types its result is built from, so
//! the schema a client validates `structuredContent` against cannot drift from the JSON the
//! handlers emit. The wire types below exist only to be derived from: the handlers still
//! build `serde_json::Value`s, and the test helpers in `lib.rs` validate every result of
//! every test against the schema here, which is what keeps the two honest.

use schemars::JsonSchema;
use schemars::r#gen::SchemaSettings;
use serde_json::Value;
use tt_store::{AgentNote, BranchResync, CalEvent, TaskItem};

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "camelCase")]
struct TaskList {
    tasks: Vec<TaskItem>,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "camelCase")]
struct OneTask {
    task: TaskItem,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "camelCase")]
struct TaskSynced {
    task: TaskItem,
    #[schemars(flatten)]
    resync: BranchResync,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "lowercase")]
enum DeleteStatus {
    Deleted,
    Refused,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
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
#[allow(dead_code)]
#[schemars(rename_all = "lowercase")]
enum Starting {
    Starting,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "camelCase")]
struct TaskStarting {
    status: Starting,
    id: i64,
    text: String,
    branch: String,
}

/// Whether the pane was placed by the caller's own terminal session or by matching the path.
#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "lowercase")]
enum Routed {
    Session,
    Path,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "lowercase")]
enum Showing {
    Showing,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "camelCase")]
struct PreviewShowing {
    status: Showing,
    path: String,
    title: String,
    routed: Routed,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "lowercase")]
enum Opening {
    Opening,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "camelCase")]
struct FileOpening {
    status: Opening,
    path: String,
    routed: Routed,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "camelCase")]
struct Waiting {
    session: Option<String>,
    title: String,
    repo: String,
    dir: String,
    reason: String,
    why: String,
    also: Vec<String>,
    since_ms: Option<i64>,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "camelCase")]
struct NeedsYou {
    waiting: Vec<Waiting>,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "lowercase")]
enum SummonStatus {
    Summoning,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "camelCase")]
struct Summoning {
    status: SummonStatus,
    session: Option<String>,
    max_minutes: i64,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "camelCase")]
struct CalendarToday {
    events: Vec<CalEvent>,
    now: i64,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "camelCase")]
struct CalendarNext {
    /// `null` when nothing is scheduled; `minutesUntil` and `live` come only with an event.
    event: Option<CalEvent>,
    minutes_until: Option<i64>,
    live: Option<bool>,
    now: i64,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
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

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "camelCase")]
struct InboxTaken {
    notes: Vec<AgentNote>,
    /// How long to wait before polling again; `0` means stop.
    poll_ms: i64,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "camelCase")]
struct InboxAcked {
    acked: i64,
}

/// A plain `number`: schemars stamps `f64` as `format: "double"`, which a client warns on.
fn number(_: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
    use schemars::schema::{InstanceType, SchemaObject};
    SchemaObject { instance_type: Some(InstanceType::Number.into()), ..Default::default() }.into()
}

fn number_or_null(_: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
    use schemars::schema::{InstanceType, SchemaObject};
    let types = vec![InstanceType::Number, InstanceType::Null];
    SchemaObject { instance_type: Some(types.into()), ..Default::default() }.into()
}

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "camelCase")]
struct NextPrompt {
    /// `null` when the model could not tell, or today's budget is spent.
    prompt: Option<String>,
    #[schemars(schema_with = "number")]
    confidence: f64,
    #[schemars(schema_with = "number_or_null")]
    cost_usd: Option<f64>,
    #[schemars(schema_with = "number")]
    budget_left_usd: f64,
}

#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename_all = "camelCase")]
struct Recorded {
    recorded: bool,
}

/// The schema for `name`'s result, or `None` for a tool with no declared output.
pub fn schema_for(name: &str) -> Option<Value> {
    Some(match name {
        "task_list" => schema::<TaskList>(),
        "task_status" | "task_create" | "task_summary" => schema::<OneTask>(),
        "task_sync" => schema::<TaskSynced>(),
        "task_delete" | "task_done" => schema::<TaskDeleted>(),
        "task_start" => schema::<TaskStarting>(),
        "preview_file" => schema::<PreviewShowing>(),
        "file_open" => schema::<FileOpening>(),
        "needs_you" => schema::<NeedsYou>(),
        "summon" => schema::<Summoning>(),
        "calendar_today" => schema::<CalendarToday>(),
        "calendar_next" => schema::<CalendarNext>(),
        "calendar_set" => schema::<CalendarWritten>(),
        "inbox_take" => schema::<InboxTaken>(),
        "inbox_ack" => schema::<InboxAcked>(),
        "next_prompt" => schema::<NextPrompt>(),
        "next_prompt_taken" => schema::<Recorded>(),
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
