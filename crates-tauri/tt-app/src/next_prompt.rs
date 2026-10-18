//! The app half of the Claude mod's model questions: `next_prompt` (the user's prompt
//! history, kept warm off the call path, and the bare `claude -p` question it is the
//! context of).

use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use tt_claude_sessions::next_prompt::{
    History, SUGGEST_SCHEMA, SuggestAnswer as ModelAnswer, TurnFacts, bucket, corpus,
    suggest_prompt, work_profile,
};

use crate::agentboard::now_ms;

const CORPUS_DAYS: f64 = 30.0;
const REBUILD_AFTER_MS: i64 = 60 * 60 * 1000;
const SIMILAR: usize = 5;
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(30);

struct Warm {
    built_at: i64,
    history: History,
    profile: String,
}

/// `None` until the first build lands; a build in flight is not started twice.
static WARM: LazyLock<Mutex<Option<Arc<Warm>>>> = LazyLock::new(Mutex::default);
static BUILDING: LazyLock<Mutex<bool>> = LazyLock::new(Mutex::default);

fn projects_dir() -> std::path::PathBuf {
    tt_config::claude_dir().join("projects")
}

/// Rebuilds on a thread of its own: parsing a month of transcripts takes seconds, and the
/// MCP dispatcher's lock must not wait on it.
pub fn warm_in_background() {
    {
        let mut building = BUILDING.lock().unwrap();
        if *building {
            return;
        }
        *building = true;
    }
    std::thread::spawn(|| {
        let started = Instant::now();
        let now = now_ms();
        match corpus(&projects_dir(), CORPUS_DAYS, now) {
            Ok(examples) => {
                let warm = Warm {
                    built_at: now,
                    history: History::from_examples(&examples),
                    profile: work_profile(&examples).line(),
                };
                *WARM.lock().unwrap() = Some(Arc::new(warm));
                tracing::info!(
                    examples = examples.len(),
                    wall_ms = started.elapsed().as_millis() as u64,
                    "next_prompt.history_built"
                );
            }
            Err(error) => tracing::warn!(%error, "next_prompt.history_failed"),
        }
        *BUILDING.lock().unwrap() = false;
    });
}

/// What is warm now, kicking off a rebuild when it is missing or stale.
fn warm() -> Option<Arc<Warm>> {
    let current = WARM.lock().unwrap().clone();
    if current.as_ref().is_none_or(|w| now_ms() - w.built_at > REBUILD_AFTER_MS) {
        warm_in_background();
    }
    current
}

pub struct AppSuggestHost;

impl tt_mcp::SuggestHost for AppSuggestHost {
    fn suggest(&self, req: tt_mcp::SuggestRequest) -> Result<tt_mcp::SuggestAnswer, String> {
        let facts = TurnFacts { tools: req.tools, commands: req.commands, answer: req.answer };
        let (similar, profile) = match warm() {
            Some(w) => (w.history.similar(bucket(&facts), SIMILAR), w.profile.clone()),
            None => (Vec::new(), String::new()),
        };
        let prompt =
            suggest_prompt(&req.question, &profile, &similar, req.goal.as_deref(), &facts.answer);
        let started = Instant::now();
        let answered = tt_exec::claude::Ask::new(&prompt, SUGGEST_SCHEMA, CLAUDE_TIMEOUT)
            .model(&req.model)
            .bare()
            .run::<ModelAnswer>();
        let wall_ms = started.elapsed().as_millis() as u64;
        let session = req.session.as_deref().unwrap_or("-");
        match answered {
            Ok(answered) => {
                let stats = answered.stats;
                tracing::info!(
                    session,
                    outcome = "ok",
                    wall_ms,
                    similar = similar.len(),
                    model = stats.model.as_str(),
                    num_turns = stats.num_turns,
                    duration_ms = stats.duration_ms,
                    cost_usd = stats.cost_usd,
                    "next_prompt.model_call"
                );
                let text = answered.answer.prompt.trim().to_string();
                Ok(tt_mcp::SuggestAnswer {
                    prompt: (!text.is_empty()).then_some(text),
                    confidence: answered.answer.confidence,
                    cost_usd: stats.cost_usd,
                })
            }
            Err(error) => {
                let reason = error.brief();
                tracing::warn!(
                    session,
                    outcome = "error",
                    reason,
                    wall_ms,
                    "next_prompt.model_call"
                );
                Err(reason)
            }
        }
    }
}

fn spend_today(
    state: &tauri::State<crate::store::StoreState>,
    ledger: tt_store::SpendLedger,
) -> Result<f64, String> {
    let day = chrono::Local::now().format("%Y-%m-%d").to_string();
    crate::store::with_store(state, |store| {
        store.model_spend(ledger, &day).map_err(|e| e.to_string())
    })
}

/// Settings shows it beside the budget, so a cap that bites is not a mystery.
#[tauri::command]
pub fn next_prompt_spend_today(
    state: tauri::State<crate::store::StoreState>,
) -> Result<f64, String> {
    spend_today(&state, tt_store::SpendLedger::NextPrompt)
}
