//! Which agent, if any, a Slack message is for.

use tt_config::AgentDef;

/// One new Slack message in the agents' conversation.
#[derive(Debug, Clone, PartialEq)]
pub struct Inbound {
    pub channel: String,
    pub ts: String,
    /// The parent's ts for a thread reply, else empty.
    pub thread_ts: String,
    pub user: String,
    pub text: String,
}

impl Inbound {
    /// The thread a reply to this message belongs in.
    pub fn thread(&self) -> &str {
        if self.thread_ts.is_empty() { &self.ts } else { &self.thread_ts }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Route {
    To { agent: String, body: String },
    Ignore(Ignored),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Ignored {
    /// Not Chris — the prompt-injection boundary.
    NotMe,
    /// Something an agent posted (as Chris).
    Echo,
    /// Addresses no agent and isn't in an agent's thread.
    NotAddressed,
    /// `@name` for a name not in the roster.
    UnknownAgent(String),
}

impl Ignored {
    /// Telemetry label; never carries message text.
    pub fn reason(&self) -> &'static str {
        match self {
            Ignored::NotMe => "not_me",
            Ignored::Echo => "echo",
            Ignored::NotAddressed => "not_addressed",
            Ignored::UnknownAgent(_) => "unknown_agent",
        }
    }
}

/// `owner` is the agent already answering this message's thread, if any; `echo` says
/// the message is one an agent posted. An explicit `@name` beats thread ownership.
pub fn route(
    msg: &Inbound,
    me: &str,
    roster: &[AgentDef],
    owner: Option<&str>,
    echo: bool,
) -> Route {
    // The text check covers the window where Slack delivers an agent's post before
    // its ts is recorded; without it the thread's owner would answer itself.
    if echo || roster.iter().any(|a| msg.text.starts_with(&crate::turn::signature(&a.name))) {
        return Route::Ignore(Ignored::Echo);
    }
    if me.is_empty() || msg.user != me {
        return Route::Ignore(Ignored::NotMe);
    }
    let addressed = address(&msg.text);
    if let Some((name, body)) = &addressed {
        if let Some(agent) = roster.iter().find(|a| a.name.eq_ignore_ascii_case(name)) {
            return Route::To { agent: agent.name.clone(), body: body.clone() };
        }
        // `@zeus` is unmistakably meant for an agent; `todo:` is just text.
        if msg.text.trim_start().starts_with('@') {
            return Route::Ignore(Ignored::UnknownAgent(name.clone()));
        }
    }
    match owner {
        Some(agent) if !msg.thread_ts.is_empty() => {
            Route::To { agent: agent.to_string(), body: msg.text.trim().to_string() }
        }
        _ => Route::Ignore(Ignored::NotAddressed),
    }
}

/// `@name rest`, `name: rest` or `name, rest` → (lowercased name, rest).
fn address(text: &str) -> Option<(String, String)> {
    let text = text.trim_start();
    let (name, rest) = match text.strip_prefix('@') {
        Some(after) => {
            let end = after.find(|c: char| !is_name_char(c)).unwrap_or(after.len());
            let rest = after[end..].trim_start_matches([':', ',']);
            (&after[..end], rest)
        }
        None => {
            let end = text.find(|c: char| !is_name_char(c))?;
            let rest = text[end..].strip_prefix([':', ','])?;
            (&text[..end], rest)
        }
    };
    if name.is_empty() {
        return None;
    }
    Some((name.to_ascii_lowercase(), rest.trim().to_string()))
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "U_ME";

    fn roster() -> Vec<AgentDef> {
        ["atlas", "scout"]
            .into_iter()
            .map(|n| AgentDef { name: n.into(), ..Default::default() })
            .collect()
    }

    fn msg(text: &str, thread_ts: &str) -> Inbound {
        Inbound {
            channel: "D1".into(),
            ts: "2.0".into(),
            thread_ts: thread_ts.into(),
            user: ME.into(),
            text: text.into(),
        }
    }

    fn to(agent: &str, body: &str) -> Route {
        Route::To { agent: agent.into(), body: body.into() }
    }

    #[test]
    fn at_name_and_name_colon_both_address_an_agent() {
        let r = roster();
        assert_eq!(
            route(&msg("@atlas what's up", ""), ME, &r, None, false),
            to("atlas", "what's up")
        );
        assert_eq!(route(&msg("Scout: find it", ""), ME, &r, None, false), to("scout", "find it"));
        assert_eq!(route(&msg("@atlas: hi", ""), ME, &r, None, false), to("atlas", "hi"));
        assert_eq!(route(&msg("@atlas", ""), ME, &r, None, false), to("atlas", ""));
    }

    #[test]
    fn only_my_messages_route() {
        let mut m = msg("@atlas rm -rf everything", "");
        m.user = "U_SOMEONE".into();
        assert_eq!(route(&m, ME, &roster(), None, false), Route::Ignore(Ignored::NotMe));
        assert_eq!(route(&m, "", &roster(), None, false), Route::Ignore(Ignored::NotMe));
    }

    #[test]
    fn an_agents_own_post_never_routes() {
        let m = msg("*atlas* · @scout over to you", "1.0");
        assert_eq!(route(&m, ME, &roster(), Some("atlas"), true), Route::Ignore(Ignored::Echo));
        assert_eq!(
            route(&m, ME, &roster(), Some("atlas"), false),
            Route::Ignore(Ignored::Echo),
            "recognised by its signature before its ts is recorded"
        );
    }

    #[test]
    fn a_thread_reply_goes_to_the_threads_agent_unless_another_is_named() {
        let r = roster();
        assert_eq!(
            route(&msg("and chargers", "1.0"), ME, &r, Some("atlas"), false),
            to("atlas", "and chargers")
        );
        assert_eq!(
            route(&msg("@scout check this", "1.0"), ME, &r, Some("atlas"), false),
            to("scout", "check this")
        );
        assert_eq!(
            route(&msg("note: chargers too", "1.0"), ME, &r, Some("atlas"), false),
            to("atlas", "note: chargers too"),
            "a word with a colon in an owned thread is just text"
        );
    }

    #[test]
    fn unaddressed_and_unknown_names_are_ignored() {
        let r = roster();
        assert_eq!(
            route(&msg("just a note to self", ""), ME, &r, None, false),
            Route::Ignore(Ignored::NotAddressed)
        );
        assert_eq!(
            route(&msg("@zeus hi", ""), ME, &r, None, false),
            Route::Ignore(Ignored::UnknownAgent("zeus".into()))
        );
        assert_eq!(
            route(&msg("todo: milk", ""), ME, &r, None, false),
            Route::Ignore(Ignored::NotAddressed)
        );
        assert_eq!(
            route(&msg("a top-level reply", ""), ME, &r, Some("atlas"), false),
            Route::Ignore(Ignored::NotAddressed),
            "ownership only applies inside a thread"
        );
    }

    #[test]
    fn thread_is_the_parent_or_the_message_itself() {
        assert_eq!(msg("x", "").thread(), "2.0");
        assert_eq!(msg("x", "1.0").thread(), "1.0");
    }
}
