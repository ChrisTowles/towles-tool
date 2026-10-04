//! Which port an app instance's MCP server lives on — the one answer both the
//! serving app and a client reaching it must agree on.
//!
//! It sits here rather than in the transport because there are now two callers on
//! opposite ends of the socket: `tt-app` binds this port, and `tt open` dials it.
//! Two copies of the precedence would be two ways to point at the wrong
//! instance, which is the exact failure the per-checkout port was introduced to
//! end (see `tt-app`'s `mcp_http` module docs for the shared-8787 history).

/// Names the MCP port an app instance serves on, in its own environment and in every
/// terminal it spawns. Rendered per checkout from the `${tt:port 8787-8986}` claim; the
/// plugin's `.mcp.json` expands it as `${TT_MCP_PORT:-8787}`.
pub const MCP_PORT_ENV: &str = "TT_MCP_PORT";

/// Most specific source first: `TT_MCP_PORT` in the process env, the checkout's `.env`
/// claim, then settings `mcp.port`. Pure so the precedence is tested directly; `0` is
/// rejected — it binds an ephemeral port no `.mcp.json` could name.
pub fn resolve_port(
    process_env: Option<&str>,
    dotenv_claim: Option<u16>,
    settings_port: u16,
) -> u16 {
    process_env
        .map(str::trim)
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|&port| port > 0)
        .or(dotenv_claim)
        .unwrap_or(settings_port)
}

/// [`resolve_port`] against the real environment: this process's env, then the `.env` of
/// the checkout the *calling process* runs in (`None` outside one). The app calls it to
/// decide what to bind and the CLI to decide what to dial; both run from the same checkout,
/// which is why one function answers both.
pub fn for_this_checkout() -> u16 {
    let settings_port =
        tt_config::load().map(|s| s.mcp.port).unwrap_or(tt_config::DEFAULT_MCP_PORT);
    let dotenv_claim = std::env::current_dir()
        .ok()
        .and_then(|dir| tt_config::checkout_root_from_dir(&dir))
        .and_then(|root| std::fs::read_to_string(root.join(".env")).ok())
        .and_then(|text| claim_in_dotenv(&text));
    resolve_port(std::env::var(MCP_PORT_ENV).ok().as_deref(), dotenv_claim, settings_port)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BindPort {
    pub port: u16,
    /// A `TT_MCP_PORT` inherited beside a `TT_SESSION_ID`: a parent app's stamp, not an override.
    pub ignored_stamp: Option<u16>,
}

/// [`resolve_port`] for the *serving* side: the stamp travels with the session id, so an app
/// launched from an app terminal inherits both and must not bind the parent's port. The
/// dialing side ([`for_this_checkout`]) differs on purpose — a client wants that very app.
pub fn resolve_bind_port(
    process_env: Option<&str>,
    session_id: Option<&str>,
    dotenv_claim: Option<u16>,
    settings_port: u16,
) -> BindPort {
    let inherited = session_id.is_some_and(|id| !id.trim().is_empty());
    if !inherited {
        let port = resolve_port(process_env, dotenv_claim, settings_port);
        return BindPort { port, ignored_stamp: None };
    }
    BindPort {
        port: resolve_port(None, dotenv_claim, settings_port),
        ignored_stamp: process_env.and_then(|v| v.trim().parse().ok()).filter(|&p| p > 0),
    }
}

/// `session_id` is the caller's own `TT_SESSION_ID`; its name belongs to `tt-agentboard`.
pub fn for_serving(session_id: Option<&str>) -> BindPort {
    let settings_port =
        tt_config::load().map(|s| s.mcp.port).unwrap_or(tt_config::DEFAULT_MCP_PORT);
    let dotenv_claim = std::env::current_dir()
        .ok()
        .and_then(|dir| tt_config::checkout_root_from_dir(&dir))
        .and_then(|root| std::fs::read_to_string(root.join(".env")).ok())
        .and_then(|text| claim_in_dotenv(&text));
    resolve_bind_port(
        std::env::var(MCP_PORT_ENV).ok().as_deref(),
        session_id,
        dotenv_claim,
        settings_port,
    )
}

/// A **port claim** ([`tt_tasks::envfile::port_claims_by_key`]), never parsed here: a value
/// the claim scanner skips is one no sibling avoids. The doctor probes this same claim.
pub fn claim_in_dotenv(text: &str) -> Option<u16> {
    tt_tasks::envfile::port_claims_by_key(text).get(MCP_PORT_ENV).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_checkouts_dotenv_claim_beats_the_shared_settings_default() {
        assert_eq!(resolve_port(None, Some(8801), 8787), 8801);
    }

    /// An explicit env var is a deliberate override, so it outranks the file.
    #[test]
    fn the_process_environment_wins_over_the_dotenv() {
        assert_eq!(resolve_port(Some("9000"), Some(8801), 8787), 9000);
    }

    /// A packaged app launched from the desktop is in no checkout and has no
    /// `.env` to read.
    #[test]
    fn settings_answer_outside_a_checkout() {
        assert_eq!(resolve_port(None, None, 9191), 9191);
    }

    /// `0` parses and still has to be rejected; the `.env` side arrives already
    /// validated by `envfile::port_claims_by_key`.
    #[test]
    fn an_unusable_override_falls_through_instead_of_binding_nonsense() {
        for bad in [
            "",
            "   ",
            "${tt:port 8787-8986}",
            "eight thousand",
            "70000",
            "-1",
            "0",
        ] {
            assert_eq!(resolve_port(Some(bad), None, 8787), 8787, "should reject {bad:?}");
            assert_eq!(resolve_port(Some(bad), Some(8801), 8787), 8801, "should reject {bad:?}");
        }
    }

    #[test]
    fn surrounding_whitespace_is_tolerated() {
        assert_eq!(resolve_port(Some(" 9000 "), None, 8787), 9000);
    }

    /// The bug: a dev app started in an app terminal bound the parent's 8787, lost, served nothing.
    #[test]
    fn a_stamp_beside_a_session_id_yields_to_the_checkouts_claim() {
        let bind = resolve_bind_port(Some("8787"), Some("s00abc"), Some(8796), 8787);
        assert_eq!(bind, BindPort { port: 8796, ignored_stamp: Some(8787) });
    }

    #[test]
    fn env_without_a_session_id_is_still_a_shell_override() {
        let bind = resolve_bind_port(Some("9000"), None, Some(8796), 8787);
        assert_eq!(bind, BindPort { port: 9000, ignored_stamp: None });
        let bind = resolve_bind_port(Some("9000"), Some("  "), Some(8796), 8787);
        assert_eq!(bind.port, 9000);
    }

    #[test]
    fn neither_env_nor_session_takes_the_claim() {
        assert_eq!(resolve_bind_port(None, None, Some(8796), 8787).port, 8796);
        assert_eq!(resolve_bind_port(None, Some("s00abc"), Some(8796), 8787).port, 8796);
    }

    #[test]
    fn no_claim_anywhere_keeps_the_settings_fallback() {
        let bind = resolve_bind_port(Some("8787"), Some("s00abc"), None, 9191);
        assert_eq!(bind, BindPort { port: 9191, ignored_stamp: Some(8787) });
        assert_eq!(resolve_bind_port(None, None, None, 9191).port, 9191);
    }

    #[test]
    fn an_unparsable_inherited_stamp_is_not_reported() {
        let bind =
            resolve_bind_port(Some("${tt:port 8787-8986}"), Some("s00abc"), Some(8796), 8787);
        assert_eq!(bind, BindPort { port: 8796, ignored_stamp: None });
    }
}
