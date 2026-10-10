//! Personal Slack agents' I/O shell: the debounce timer, one turn at a time per agent,
//! reactions, and posting replies. Every decision — routing, the locked-down argv, the
//! reply contract — lives in the Tauri-free `tt_agents` and is unit-tested there.
//!
//! Messages arrive from `slack_socket`, so only the instance holding the socket's
//! singleton lock ever starts a turn. Reminders fire from this instance's own tt.db,
//! where the turns that set them were recorded.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use tokio::sync::mpsc;
use tt_agents::{Batcher, Inbound, Job, Route, TurnInput};
use tt_collect::MessageEvent;
use tt_config::{AgentDef, AgentsSettings};

const REMINDER_TICK: Duration = Duration::from_secs(30);
const IDLE: Duration = Duration::from_secs(3600);
const QUEUED: &str = "eyes";
const WORKING: &str = "hourglass_flowing_sand";

enum Event {
    Message(MessageEvent),
    TurnDone(String),
}

/// The socket's handle for forwarding every message event it sees.
#[derive(Clone)]
pub struct AgentsTx(mpsc::UnboundedSender<Event>);

impl AgentsTx {
    pub fn message(&self, event: MessageEvent) {
        let _ = self.0.send(Event::Message(event));
    }
}

/// Settings plus the two Slack facts they imply: who "me" is and which conversation.
#[derive(Clone)]
struct Ctx {
    token: String,
    me: String,
    channel: String,
    settings: AgentsSettings,
}

impl Ctx {
    fn agent(&self, name: &str) -> Option<AgentDef> {
        self.settings.roster.iter().find(|a| a.name == name).cloned()
    }
}

struct Item {
    ts: String,
    at_ms: i64,
    text: String,
}

struct Runtime {
    tx: mpsc::UnboundedSender<Event>,
    ctx: Option<Ctx>,
    batcher: Batcher<(String, String), Item>,
    busy: HashSet<String>,
    waiting: HashMap<String, VecDeque<Job>>,
}

pub fn spawn() -> AgentsTx {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let defaults = AgentsSettings::default();
    let mut rt = Runtime {
        tx: tx.clone(),
        ctx: None,
        batcher: Batcher::new(defaults.quiet_ms, defaults.cap_ms),
        busy: HashSet::new(),
        waiting: HashMap::new(),
    };
    tauri::async_runtime::spawn(async move {
        let mut reminders = tokio::time::interval(REMINDER_TICK);
        loop {
            let wait = rt
                .batcher
                .next_deadline()
                .map(|d| Duration::from_millis((d - now_ms()).max(0) as u64))
                .unwrap_or(IDLE);
            tokio::select! {
                event = rx.recv() => match event {
                    Some(Event::Message(m)) => rt.on_message(m).await,
                    Some(Event::TurnDone(agent)) => rt.on_done(&agent),
                    None => return,
                },
                _ = tokio::time::sleep(wait) => rt.flush().await,
                _ = reminders.tick() => rt.fire_reminders().await,
            }
        }
    });
    AgentsTx(tx)
}

impl Runtime {
    /// Re-read per event (it's a small file) so roster and prompt edits apply live; the
    /// Slack lookups are cached until the token or conversation changes.
    async fn refresh_ctx(&mut self) -> Option<Ctx> {
        let settings = tt_config::load().ok()?;
        let agents = settings.agents;
        let token = settings.collectors.slack.token;
        if !agents.enabled || token.trim().is_empty() {
            self.ctx = None;
            return None;
        }
        if self.batcher.next_deadline().is_none() {
            self.batcher = Batcher::new(agents.quiet_ms, agents.cap_ms);
        }
        if let Some(ctx) = &mut self.ctx
            && ctx.token == token
            && ctx.settings.conversation == agents.conversation
        {
            ctx.settings = agents;
            return Some(ctx.clone());
        }
        let (t, conversation) = (token.clone(), agents.conversation.clone());
        let resolved = tauri::async_runtime::spawn_blocking(move || {
            let me = tt_collect::auth_user_id(&t)?;
            let channel =
                if conversation.is_empty() { tt_collect::open_im(&t, &me)? } else { conversation };
            Ok::<_, String>((me, channel))
        })
        .await
        .ok()?;
        match resolved {
            Ok((me, channel)) => {
                self.ctx = Some(Ctx { token, me, channel, settings: agents });
                self.ctx.clone()
            }
            Err(error) => {
                tracing::warn!(error = %error, "agent.slack_unavailable");
                None
            }
        }
    }

    async fn on_message(&mut self, event: MessageEvent) {
        if !tt_collect::is_new_message(&event) {
            return;
        }
        let Some(ctx) = self.refresh_ctx().await else {
            return;
        };
        if event.channel != ctx.channel {
            return;
        }
        let msg = Inbound {
            channel: event.channel,
            ts: event.ts,
            thread_ts: event.thread_ts,
            user: event.user,
            text: event.text,
        };
        let (channel, ts, thread_ts) = (msg.channel.clone(), msg.ts.clone(), msg.thread_ts.clone());
        let (echo, owner) = blocking(move |store| {
            let echo = store.is_agent_post(&channel, &ts).unwrap_or(false);
            let owner = if thread_ts.is_empty() {
                None
            } else {
                store.thread_owner(&channel, &thread_ts).ok().flatten()
            };
            (echo, owner)
        })
        .await
        .unwrap_or((false, None));
        match tt_agents::route(&msg, &ctx.me, &ctx.settings.roster, owner.as_deref(), echo) {
            Route::Ignore(why) => tracing::debug!(reason = why.reason(), "agent.ignored"),
            Route::To { agent, body } => {
                let key = (agent, msg.thread().to_string());
                let now = now_ms();
                self.batcher.push(key, Item { ts: msg.ts, at_ms: now, text: body }, now);
            }
        }
    }

    async fn flush(&mut self) {
        let Some(ctx) = self.ctx.clone() else { return };
        for ((agent, thread), items) in self.batcher.due(now_ms()) {
            let job = Job {
                agent,
                channel: ctx.channel.clone(),
                thread,
                inputs: items
                    .iter()
                    .map(|i| TurnInput::Message { text: i.text.clone(), at_ms: i.at_ms })
                    .collect(),
                message_ts: items.into_iter().map(|i| i.ts).collect(),
            };
            // Claimed now, not when the reply lands, so a follow-up typed mid-turn
            // already routes here.
            let (channel, thread, agent) =
                (job.channel.clone(), job.thread.clone(), job.agent.clone());
            blocking(move |store| store.claim_thread(&channel, &thread, &agent)).await;
            self.dispatch(&ctx, job);
        }
    }

    async fn fire_reminders(&mut self) {
        let Some(ctx) = self.refresh_ctx().await else {
            return;
        };
        let due = blocking(|store| store.take_due_agent_reminders(now_ms()).unwrap_or_default())
            .await
            .unwrap_or_default();
        for reminder in due {
            tracing::info!(agent = %reminder.agent, "agent.reminder_fired");
            let job = Job {
                agent: reminder.agent,
                channel: reminder.channel,
                thread: reminder.thread_ts,
                inputs: vec![TurnInput::Reminder { note: reminder.note, due_ms: reminder.due_at }],
                message_ts: Vec::new(),
            };
            self.dispatch(&ctx, job);
        }
    }

    /// One turn at a time per agent: a busy agent's job waits, marked 👀 in Slack.
    fn dispatch(&mut self, ctx: &Ctx, job: Job) {
        if self.busy.contains(&job.agent) {
            react_all(ctx, &job.message_ts, QUEUED, true);
            self.waiting.entry(job.agent.clone()).or_default().push_back(job);
            return;
        }
        self.start(ctx, job);
    }

    fn on_done(&mut self, agent: &str) {
        self.busy.remove(agent);
        let next = self.waiting.get_mut(agent).and_then(VecDeque::pop_front);
        if let (Some(job), Some(ctx)) = (next, self.ctx.clone()) {
            self.start(&ctx, job);
        }
    }

    fn start(&mut self, ctx: &Ctx, job: Job) {
        let Some(def) = ctx.agent(&job.agent) else {
            tracing::info!(agent = %job.agent, "agent.not_in_roster");
            return;
        };
        self.busy.insert(job.agent.clone());
        let (ctx, tx) = (ctx.clone(), self.tx.clone());
        tauri::async_runtime::spawn(async move {
            let agent = job.agent.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || run_turn(&ctx, &def, &job)).await;
            let _ = tx.send(Event::TurnDone(agent));
        });
    }
}

/// Blocking: Slack HTTP, tt.db and the `claude` process itself.
fn run_turn(ctx: &Ctx, def: &AgentDef, job: &Job) {
    react_each(ctx, &job.message_ts, QUEUED, false);
    react_each(ctx, &job.message_ts, WORKING, true);
    tracing::info!(agent = %def.name, inputs = job.inputs.len(), "agent.turn_started");
    let now = now_ms();
    let timeout = Duration::from_secs(ctx.settings.turn_timeout_minutes.max(1) * 60);
    let result = match (tt_store::Store::open_default(), tt_config::agents_dir()) {
        (Ok(store), Ok(dir)) => {
            tt_agents::execute(&store, &dir, &ctx.settings.prompt, def, job, timeout, now)
        }
        (Err(e), _) => Err(tt_agents::Error::Exec(format!("store: {e}"))),
        (_, Err(e)) => Err(tt_agents::Error::Exec(format!("agents dir: {e}"))),
    };
    let text = match &result {
        Ok(turn) => tt_agents::slack_text(&def.name, &turn.reply, now),
        Err(e) => tt_agents::slack_error(&def.name, e),
    };
    match tt_collect::post_message(&ctx.token, &job.channel, &text, &job.thread) {
        Ok(ts) => {
            if let Ok(store) = tt_store::Store::open_default() {
                let _ = store.record_agent_post(&job.channel, &ts, &def.name, now_ms());
                let _ = store.claim_thread(&job.channel, &job.thread, &def.name);
            }
        }
        Err(e) => tracing::warn!(agent = %def.name, error = %e, "agent.post_failed"),
    }
    react_each(ctx, &job.message_ts, WORKING, false);
    match &result {
        Ok(turn) => tracing::info!(
            agent = %def.name,
            outcome = "ok",
            cost_usd = turn.cost_usd.unwrap_or_default(),
            denials = turn.denials.len(),
            reminder_set = turn.reply.remind.is_some(),
            "agent.turn_finished"
        ),
        Err(e) => {
            tracing::info!(agent = %def.name, outcome = "error", error = %e.brief(), "agent.turn_finished")
        }
    }
}

fn react_each(ctx: &Ctx, message_ts: &[String], name: &str, add: bool) {
    for ts in message_ts {
        let _ = tt_collect::react(&ctx.token, &ctx.channel, ts, name, add);
    }
}

/// [`react_each`] off the runtime loop, which must not block on HTTP.
fn react_all(ctx: &Ctx, message_ts: &[String], name: &'static str, add: bool) {
    if message_ts.is_empty() {
        return;
    }
    let (ctx, message_ts) = (ctx.clone(), message_ts.to_vec());
    tauri::async_runtime::spawn_blocking(move || react_each(&ctx, &message_ts, name, add));
}

/// Run `f` against this instance's tt.db on a blocking thread; `None` if it won't open.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce(&tt_store::Store) -> T + Send + 'static,
) -> Option<T> {
    tauri::async_runtime::spawn_blocking(move || {
        tt_store::Store::open_default().ok().map(|s| f(&s))
    })
    .await
    .ok()
    .flatten()
}

fn now_ms() -> i64 {
    chrono::Local::now().timestamp_millis()
}
