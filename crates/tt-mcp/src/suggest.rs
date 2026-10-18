//! The Claude mod's next-prompt suggestion (one model call per keystroke of the user's,
//! held to a daily budget here so no caller can spend past it) and the end-of-turn
//! clipboard offer, which makes no model call.

use chrono::{Local, TimeZone};
use serde_json::{Value, json};
use tt_config::{ClipSuggestSettings, NextPromptSettings};
use tt_store::SpendLedger;

use crate::{Dispatcher, RequestContext, clip_gate};

/// What the app needs to ask: the last turn as the mod saw it, plus the user's settings.
pub struct SuggestRequest {
    pub session: Option<String>,
    pub tools: Vec<String>,
    pub commands: Vec<String>,
    pub answer: String,
    pub goal: Option<String>,
    pub question: String,
    pub model: String,
}

pub struct SuggestAnswer {
    /// `None` when the model could not tell.
    pub prompt: Option<String>,
    pub confidence: f64,
    pub cost_usd: Option<f64>,
}

/// The app-side half of `next_prompt`: the user's history and the `claude -p` spawn live there.
pub trait SuggestHost: Send {
    fn suggest(&self, request: SuggestRequest) -> Result<SuggestAnswer, String>;
}

pub(crate) fn local_day(now_ms: i64) -> String {
    Local
        .timestamp_millis_opt(now_ms)
        .single()
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

fn strings(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

impl Dispatcher {
    fn next_prompt_settings(&self) -> NextPromptSettings {
        match &self.next_prompt_settings {
            Some(settings) => settings.clone(),
            None => tt_config::load().map(|s| s.next_prompt).unwrap_or_default(),
        }
    }

    pub(crate) fn next_prompt(
        &self,
        args: &Value,
        now_ms: i64,
        ctx: &RequestContext,
    ) -> Result<Value, String> {
        let host = self
            .suggest_host
            .as_ref()
            .ok_or_else(|| "next_prompt is unavailable: no suggest host is attached".to_string())?;
        let settings = self.next_prompt_settings();
        let day = local_day(now_ms);
        let spent =
            self.store.model_spend(SpendLedger::NextPrompt, &day).map_err(|e| e.to_string())?;
        if spent >= settings.daily_budget_usd {
            tracing::info!(spent, budget = settings.daily_budget_usd, "next_prompt.over_budget");
            return Ok(json!({
                "prompt": null, "confidence": 0.0, "costUsd": null, "budgetLeftUsd": 0.0,
            }));
        }
        let goal = self.goal_of(args);
        let answer = host.suggest(SuggestRequest {
            session: ctx.session.clone(),
            tools: strings(args, "tools"),
            commands: strings(args, "commands"),
            answer: args.get("answer").and_then(Value::as_str).unwrap_or_default().to_string(),
            goal,
            question: if settings.question.trim().is_empty() {
                tt_config::DEFAULT_NEXT_PROMPT_QUESTION.to_string()
            } else {
                settings.question
            },
            model: settings.model,
        })?;
        let cost = answer.cost_usd.unwrap_or(0.0);
        if cost > 0.0 {
            self.store
                .add_model_spend(SpendLedger::NextPrompt, &day, cost)
                .map_err(|e| e.to_string())?;
        }
        tracing::info!(
            cost_usd = cost,
            confidence = answer.confidence,
            answered = answer.prompt.is_some(),
            "next_prompt.asked"
        );
        Ok(json!({
            "prompt": answer.prompt,
            "confidence": answer.confidence,
            "costUsd": answer.cost_usd,
            "budgetLeftUsd": (settings.daily_budget_usd - spent - cost).max(0.0),
        }))
    }

    pub(crate) fn next_prompt_taken(&self, args: &Value) -> Result<Value, String> {
        let edited = args.get("edited").and_then(Value::as_bool).unwrap_or(false);
        tracing::info!(edited, "next_prompt.taken");
        Ok(json!({ "recorded": true }))
    }

    fn goal_of(&self, args: &Value) -> Option<String> {
        let id = args.get("taskId").and_then(Value::as_i64)?;
        self.store.task_by_id(id).ok().and_then(|t| t.goal)
    }

    fn clip_settings(&self) -> ClipSuggestSettings {
        match &self.clip_settings {
            Some(settings) => settings.clone(),
            None => tt_config::load().map(|s| s.clip_suggest).unwrap_or_default(),
        }
    }

    pub(crate) fn clip_suggest(
        &mut self,
        args: &Value,
        now_ms: i64,
        ctx: &RequestContext,
    ) -> Result<Value, String> {
        let none = |skipped: &str| Ok(json!({ "items": [], "skipped": skipped }));
        if !self.clip_settings().enabled {
            return none("disabled");
        }
        let said = args.get("answer").and_then(Value::as_str).unwrap_or_default();
        let offers = clip_gate::offers(said);
        if offers.is_empty() {
            tracing::info!(reason = "no-bang-command", "clip_suggest.skipped");
            return none("no-bang-command");
        }
        if ctx.session.as_deref().is_some_and(|s| self.clip_backoff.quiet(s, now_ms)) {
            tracing::info!(reason = "ignored", "clip_suggest.skipped");
            return none("ignored");
        }
        tracing::info!(items = offers.len(), "clip_suggest.asked");
        if let Some(session) = ctx.session.as_deref() {
            self.clip_backoff.offered(session, now_ms);
        }
        let items: Vec<Value> =
            offers.iter().map(|o| json!({ "label": o.label, "text": o.text })).collect();
        Ok(json!({ "items": items, "skipped": null }))
    }

    pub(crate) fn clip_copied(
        &mut self,
        args: &Value,
        ctx: &RequestContext,
    ) -> Result<Value, String> {
        if let Some(session) = ctx.session.as_deref() {
            self.clip_backoff.copied(session);
        }
        let index = args.get("index").and_then(Value::as_i64);
        let count = args.get("count").and_then(Value::as_i64).unwrap_or(1);
        tracing::info!(index, count, "clip_suggest.copied");
        Ok(json!({ "recorded": true }))
    }
}
