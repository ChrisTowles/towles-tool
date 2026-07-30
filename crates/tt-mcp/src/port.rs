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

/// The port this instance should serve on, most specific source first:
///
/// 1. `TT_MCP_PORT` in the process's own environment — an explicit override (a nested app
///    inherits none of it: the PTY scrub drops `TT_*`).
/// 2. The checkout's `TT_MCP_PORT` claim from its rendered `.env` — the normal case.
/// 3. The settings `mcp.port` — a machine-wide default outside any checkout.
///
/// Pure so the precedence is tested directly: getting it wrong points every session at one
/// instance again. A `0` is rejected with unparseable junk — port 0 binds an ephemeral port
/// no `.mcp.json` could name.
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

/// [`resolve_port`] against the real environment: this process's env, then the
/// `.env` of the checkout the *calling process* runs in (`None` outside one).
///
/// Called by the app to decide what to bind and by the CLI to decide what to
/// dial. Both run from the same checkout in the normal case, which is precisely
/// why one function answers both.
///
/// The `.env` value is read as a **port claim** ([`tt_tasks::envfile::port_claims_by_key`])
/// rather than parsed here, so the app binds exactly the port its siblings see as taken —
/// a value the claim scanner skips is one no sibling avoids, yet this app would bind it.
pub fn for_this_checkout() -> u16 {
    let settings_port =
        tt_config::load().map(|s| s.mcp.port).unwrap_or(tt_config::DEFAULT_MCP_PORT);
    let dotenv_claim = std::env::current_dir()
        .ok()
        .and_then(|dir| tt_config::checkout_root_from_dir(&dir))
        .and_then(|root| std::fs::read_to_string(root.join(".env")).ok())
        .and_then(|text| tt_tasks::envfile::port_claims_by_key(&text).get(MCP_PORT_ENV).copied());
    resolve_port(std::env::var(MCP_PORT_ENV).ok().as_deref(), dotenv_claim, settings_port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_checkouts_dotenv_claim_beats_the_shared_settings_default() {
        assert_eq!(resolve_port(None, Some(8801), 8787), 8801);
    }

    /// An explicit env var is a deliberate override (a script, a hand-run
    /// binary), so it outranks the file.
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

    /// An override can be a blank, junk, or out of range. Falling *through* to
    /// the next source keeps the app serving on a sane port. `0` is the one
    /// that parses and still has to be rejected — binding it takes an ephemeral
    /// port no `.mcp.json` could name.
    ///
    /// The `.env` side needs no equivalent: it arrives as an already-validated
    /// claim from `envfile::port_claims_by_key`, which is tested in `tt-tasks`
    /// and is what rejects an unsubstituted `${tt:port 8787-8986}` token there.
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
}
