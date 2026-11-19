---- MODULE GitCache ----
\* One checkout's git-info cache entry under the two pollers that refresh it:
\* Engine::stale_git_targets claims, compute_git_info reads the repo off the
\* engine lock, Engine::store_git_info stores (crates/tt-agentboard/src/
\* engine/git_refresh.rs; the loops are in crates-tauri/tt-app/src/lib.rs).
\* invalidate_git (fs-notify, turn end, focus) marks it stale; task removal's
\* drop_git_cache forgets it. docs/GIT-FRESHNESS.md has the rules.
\* Out of scope: a claim outliving GIT_PENDING_GUARD_MS (a 30s compute).
EXTENDS Naturals

\* ClaimAware: an invalidation landing on a claimed dir dirties the claim so
\* its store lands stale, and a store for a dir dropped since its claim is
\* discarded.
CONSTANTS Pollers, MaxCommits, ClaimAware

VARIABLES
  repo,       \* the repository's real state, as a commit count
  notify,     \* a change the fs-notify watcher has not delivered yet
  tracked,    \* the checkout is still on the rail
  entry,      \* GitCache: [has, val, fresh]
  claim,      \* git_pending[dir]: [held, dirty]
  dropped,    \* drop_git_cache ran since the last claim (ClaimAware)
  pc, snap    \* each poller: "idle" | "computing" | "storing", and what it read

vars == <<repo, notify, tracked, entry, claim, dropped, pc, snap>>

Init ==
  /\ repo = 0 /\ notify = FALSE /\ tracked = TRUE
  /\ entry = [has |-> FALSE, val |-> 0, fresh |-> FALSE]
  /\ claim = [held |-> FALSE, dirty |-> FALSE]
  /\ dropped = FALSE
  /\ pc = [p \in Pollers |-> "idle"] /\ snap = [p \in Pollers |-> 0]

\* Someone commits, checks out, or edits the index.
Commit ==
  /\ tracked /\ repo < MaxCommits
  /\ repo' = repo + 1 /\ notify' = TRUE
  /\ UNCHANGED <<tracked, entry, claim, dropped, pc, snap>>

\* The MultiFileNotifier fires: Engine::invalidate_git zeroes the stamp.
Invalidate ==
  /\ notify
  /\ notify' = FALSE
  /\ entry' = [entry EXCEPT !.fresh = FALSE]
  /\ claim' = IF ClaimAware /\ claim.held THEN [claim EXCEPT !.dirty = TRUE] ELSE claim
  /\ UNCHANGED <<repo, tracked, dropped, pc, snap>>

\* GIT_CACHE_TTL_MS runs out: the backstop for a missed event.
Expire ==
  /\ entry.fresh
  /\ entry' = [entry EXCEPT !.fresh = FALSE]
  /\ UNCHANGED <<repo, notify, tracked, claim, dropped, pc, snap>>

\* stale_git_targets: a stale, unclaimed dir is claimed under the engine lock.
Claim(p) ==
  /\ pc[p] = "idle" /\ tracked
  /\ ~entry.fresh /\ ~claim.held
  /\ claim' = [held |-> TRUE, dirty |-> FALSE]
  /\ dropped' = FALSE
  /\ pc' = [pc EXCEPT ![p] = "computing"]
  /\ UNCHANGED <<repo, notify, tracked, entry, snap>>

\* compute_git_info, off the lock.
Read(p) ==
  /\ pc[p] = "computing"
  /\ snap' = [snap EXCEPT ![p] = repo]
  /\ pc' = [pc EXCEPT ![p] = "storing"]
  /\ UNCHANGED <<repo, notify, tracked, entry, claim, dropped>>

\* store_git_info: insert stamped with the batch's finish time, drop the claim.
Store(p) ==
  /\ pc[p] = "storing"
  /\ IF ClaimAware /\ dropped
     THEN UNCHANGED entry
     ELSE entry' = [has |-> TRUE, val |-> snap[p], fresh |-> ~(ClaimAware /\ claim.dirty)]
  /\ claim' = [held |-> FALSE, dirty |-> FALSE]
  /\ pc' = [pc EXCEPT ![p] = "idle"]
  /\ UNCHANGED <<repo, notify, tracked, dropped, snap>>

\* Task removal: the worktree is gone, drop_git_cache forgets entry and claim.
Drop ==
  /\ tracked
  /\ tracked' = FALSE
  /\ entry' = [has |-> FALSE, val |-> 0, fresh |-> FALSE]
  /\ claim' = [held |-> FALSE, dirty |-> FALSE]
  /\ dropped' = ClaimAware
  /\ UNCHANGED <<repo, notify, pc, snap>>

Next ==
  \/ Commit \/ Invalidate \/ Expire \/ Drop
  \/ \E p \in Pollers : Claim(p) \/ Read(p) \/ Store(p)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ repo \in 0..MaxCommits /\ notify \in BOOLEAN /\ tracked \in BOOLEAN
  /\ entry.has \in BOOLEAN /\ entry.fresh \in BOOLEAN
  /\ pc \in [Pollers -> {"idle", "computing", "storing"}]

Settled == ~notify /\ \A p \in Pollers : pc[p] = "idle"

\* Once every event is delivered and nothing is computing, an entry that
\* claims to be fresh matches the repository: no stats held stale until the
\* 60s TTL.
FreshMeansCurrent == (Settled /\ entry.fresh) => entry.val = repo

\* A removed checkout's stats don't come back: a later task at the same path
\* must not inherit them.
DroppedStaysDropped == (Settled /\ ~tracked) => ~entry.has
====
