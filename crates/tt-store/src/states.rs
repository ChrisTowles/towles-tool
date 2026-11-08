//! The closed vocabularies the collectors write as text: PR state, checks rollup, review
//! verdict, CI run status and conclusion. Parsed once where rows are read, so downstream
//! code `match`es instead of comparing strings.
//!
//! Each enum keeps the exact wire string it had as text. A value the build does not know
//! reads as `Unknown` rather than failing the whole read: one odd row must not blank the
//! queue, and `Unknown` matches no arm that acts on a state, so it is inert.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

macro_rules! wire_enum {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident = $wire:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
        pub enum $name {
            $($(#[$vmeta])* #[serde(rename = $wire)] $variant,)+
            /// A value this build does not know; never matches an arm that acts on a state.
            #[serde(other, rename = "unknown")]
            Unknown,
        }

        impl $name {
            /// The stored/wire text.
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire,)+
                    Self::Unknown => "unknown",
                }
            }

            /// Case-insensitive, since GitHub's own casing varies by endpoint.
            pub fn parse(s: &str) -> Self {
                $(if s.eq_ignore_ascii_case($wire) { return Self::$variant; })+
                Self::Unknown
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl rusqlite::types::FromSql for $name {
            fn column_result(v: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
                v.as_str().map(Self::parse)
            }
        }

        impl rusqlite::types::ToSql for $name {
            fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
                Ok(self.as_str().into())
            }
        }
    };
}

wire_enum! {
    /// A pull request's lifecycle.
    PrState { Open = "open", Merged = "merged", Closed = "closed" }
}

wire_enum! {
    /// The rollup of a PR's status checks; `None` means it has no checks at all.
    ChecksState { Passing = "passing", Failing = "failing", Pending = "pending", None = "none" }
}

wire_enum! {
    /// The review verdict stored on a PR. `Requested` is your review being asked for, set by
    /// the review-requested sweep; the rest are `reviewDecision` of your own PRs; `None` is
    /// no verdict.
    ReviewState {
        Requested = "review_requested",
        Approved = "approved",
        ChangesRequested = "changes_requested",
        ReviewRequired = "review_required",
        None = "",
    }
}

wire_enum! {
    /// A workflow run's progress; `conclusion` is only meaningful once `Completed`.
    CiStatus {
        Queued = "queued",
        InProgress = "in_progress",
        Completed = "completed",
        Waiting = "waiting",
        Requested = "requested",
        Pending = "pending",
    }
}

wire_enum! {
    /// How a completed run ended; `None` while it is still in flight.
    CiConclusion {
        Success = "success",
        Failure = "failure",
        Neutral = "neutral",
        Cancelled = "cancelled",
        Skipped = "skipped",
        TimedOut = "timed_out",
        ActionRequired = "action_required",
        StartupFailure = "startup_failure",
        Stale = "stale",
        None = "",
    }
}

impl CiConclusion {
    /// A finished run that broke, the one verdict the queue and notifications act on.
    pub fn is_failure(self) -> bool {
        matches!(self, Self::Failure | Self::TimedOut | Self::StartupFailure)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    macro_rules! round_trip {
        ($ty:ident: $($variant:ident = $wire:literal),+) => {$(
            assert_eq!($ty::parse($wire), $ty::$variant);
            assert_eq!($ty::$variant.as_str(), $wire);
            assert_eq!(serde_json::to_string(&$ty::$variant).unwrap(), format!("{:?}", $wire));
            assert_eq!(serde_json::from_str::<$ty>(&format!("{:?}", $wire)).unwrap(), $ty::$variant);
        )+};
    }

    #[test]
    fn every_variant_round_trips_through_text_and_json() {
        round_trip!(PrState: Open = "open", Merged = "merged", Closed = "closed");
        round_trip!(ChecksState: Passing = "passing", Failing = "failing", Pending = "pending",
            None = "none");
        round_trip!(ReviewState: Requested = "review_requested", Approved = "approved",
            ChangesRequested = "changes_requested", ReviewRequired = "review_required", None = "");
        round_trip!(CiStatus: Queued = "queued", InProgress = "in_progress",
            Completed = "completed", Waiting = "waiting", Requested = "requested",
            Pending = "pending");
        round_trip!(CiConclusion: Success = "success", Failure = "failure", Neutral = "neutral",
            Cancelled = "cancelled", Skipped = "skipped", TimedOut = "timed_out",
            ActionRequired = "action_required", StartupFailure = "startup_failure",
            Stale = "stale", None = "");
    }

    #[test]
    fn an_unknown_value_reads_as_unknown_not_an_error() {
        assert_eq!(PrState::parse("draft"), PrState::Unknown);
        assert_eq!(PrState::parse(""), PrState::Unknown);
        assert_eq!(ChecksState::parse("flaky"), ChecksState::Unknown);
        assert_eq!(
            serde_json::from_str::<ReviewState>("\"dismissed\"").unwrap(),
            ReviewState::Unknown
        );
        assert_eq!(serde_json::to_string(&CiStatus::Unknown).unwrap(), "\"unknown\"");
    }

    #[test]
    fn parse_ignores_github_casing() {
        assert_eq!(PrState::parse("OPEN"), PrState::Open);
        assert_eq!(CiConclusion::parse("TIMED_OUT"), CiConclusion::TimedOut);
    }

    #[test]
    fn only_broken_conclusions_are_failures() {
        let broken: Vec<_> = [
            CiConclusion::Failure,
            CiConclusion::TimedOut,
            CiConclusion::StartupFailure,
        ]
        .into_iter()
        .collect();
        assert!(broken.iter().all(|c| c.is_failure()));
        for ok in [
            CiConclusion::Success,
            CiConclusion::Cancelled,
            CiConclusion::None,
            CiConclusion::Unknown,
        ] {
            assert!(!ok.is_failure());
        }
    }

    #[test]
    fn sqlite_stores_the_wire_text() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('changes_requested'), ('weird');",
        )
        .unwrap();
        let got: Vec<ReviewState> = conn
            .prepare("SELECT v FROM t")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(got, [ReviewState::ChangesRequested, ReviewState::Unknown]);
        conn.execute("UPDATE t SET v = ?1", [ReviewState::Approved]).unwrap();
        let text: String = conn.query_row("SELECT v FROM t LIMIT 1", [], |r| r.get(0)).unwrap();
        assert_eq!(text, "approved");
    }
}
