---- MODULE PtySession ----
\* One terminal id's shell across pane mounts: TerminalView's mount effect
\* (apps/client/src/components/terminal-view.tsx) against term_start,
\* term_kill and the reader thread's EOF (crates-tauri/tt-app/src/terminal/
\* spawn.rs, session.rs). A remount happens whenever the effect's deps change
\* (termId, cwd) and twice per mount under StrictMode. Each mount is a view
\* v; the shell its term_start spawns has generation v. Client calls go out
\* through `fire`, so a term_kill and a later term_start race on the backend.
EXTENDS Naturals, FiniteSets

\* GenChecked: term_kill names the generation it means, and an insert never
\* replaces a newer generation (generations are taken in call order).
CONSTANTS Views, GenChecked

VARIABLES
  view,      \* view[v]: "idle" | "starting" | "running" | "exited" | "gone"
  replied,   \* view v's term_start reply has reached the client
  start,     \* backend term_start for view v: "none" | "kill" | "insert" | "reply" | "done"
  kills,     \* term_kill calls in flight, as <<view, generation>>
  map,       \* TermState.sessions[id]: the owning generation, 0 for none
  alive,     \* generations whose shell process is running
  eof        \* generations whose reader thread has hit EOF but not yet run take_if_current

vars == <<view, replied, start, kills, map, alive, eof>>

Init ==
  /\ view = [v \in Views |-> "idle"]
  /\ replied = [v \in Views |-> FALSE]
  /\ start = [v \in Views |-> "none"]
  /\ kills = {} /\ map = 0 /\ alive = {} /\ eof = {}

\* The client knows the generation only once term_start has answered.
KnownGen(v) == IF GenChecked /\ replied[v] THEN v ELSE 0

\* --- client: terminal-view.tsx --------------------------------------------

\* The effect runs: listeners up, then term_start. Mounts are sequential:
\* the previous one has unmounted (its cleanup ran) first.
Mount(v) ==
  /\ view[v] = "idle"
  /\ \A w \in Views : w < v => view[w] \in {"idle", "gone"}
  /\ \A w \in Views : w > v => view[w] = "idle"
  /\ view' = [view EXCEPT ![v] = "starting"]
  /\ start' = [start EXCEPT ![v] = "kill"]
  /\ UNCHANGED <<replied, kills, map, alive, eof>>

\* Cleanup: disposed = true; `if (started) send("term_kill")`.
Unmount(v) ==
  /\ view[v] \in {"starting", "running", "exited"}
  /\ view' = [view EXCEPT ![v] = "gone"]
  /\ kills' = IF replied[v] THEN kills \cup {<<v, KnownGen(v)>>} ELSE kills
  /\ UNCHANGED <<replied, start, map, alive, eof>>

\* term_start resolves: `started = true; if (disposed) send("term_kill")`.
Reply(v) ==
  /\ start[v] = "reply"
  /\ start' = [start EXCEPT ![v] = "done"]
  /\ replied' = [replied EXCEPT ![v] = TRUE]
  /\ IF view[v] = "gone"
     THEN /\ kills' = kills \cup {<<v, IF GenChecked THEN v ELSE 0>>}
          /\ UNCHANGED view
     ELSE /\ view' = [view EXCEPT ![v] = IF @ = "starting" THEN "running" ELSE @]
          /\ UNCHANGED kills
  /\ UNCHANGED <<map, alive, eof>>

\* --- backend: spawn.rs / session.rs ---------------------------------------

Reap(g) == /\ alive' = alive \ {g}
           /\ eof' = IF g \in alive THEN eof \cup {g} ELSE eof

\* term_start_blocking: state.kill(&term_id) — detach whatever owns the id;
\* GenChecked, only an older generation.
StartKill(v) ==
  /\ start[v] = "kill"
  /\ start' = [start EXCEPT ![v] = "insert"]
  /\ IF map /= 0 /\ (~GenChecked \/ map < v)
     THEN map' = 0 /\ Reap(map)
     ELSE UNCHANGED <<map, alive, eof>>
  /\ UNCHANGED <<view, replied, kills>>

\* openpty, spawn, then state.insert: a session that slipped in since the
\* kill is overwritten and dropped, which hangs up its shell. GenChecked: a
\* newer one stays, and this call reaps the shell it just spawned.
StartInsert(v) ==
  /\ start[v] = "insert"
  /\ start' = [start EXCEPT ![v] = "reply"]
  /\ IF GenChecked /\ map > v
     THEN UNCHANGED <<map, alive, eof>>
     ELSE /\ map' = v
          /\ IF map /= 0
             THEN /\ alive' = (alive \ {map}) \cup {v}
                  /\ eof' = eof \cup {map}
             ELSE /\ alive' = alive \cup {v}
                  /\ UNCHANGED eof
  /\ UNCHANGED <<view, replied, kills>>

\* term_kill: detach(&term_id) — by id, or by generation once GenChecked.
TermKill(k) ==
  /\ k \in kills
  /\ kills' = kills \ {k}
  /\ IF map /= 0 /\ (k[2] = 0 \/ k[2] = map)
     THEN /\ map' = 0
          /\ Reap(map)
     ELSE UNCHANGED <<map, alive, eof>>
  /\ UNCHANGED <<view, replied, start>>

\* The user types `exit`, or the program crashes.
ShellExits(g) ==
  /\ g \in alive
  /\ Reap(g)
  /\ UNCHANGED <<view, replied, start, kills, map>>

\* Reader thread: take_if_current(term_id, generation), and only then emit
\* terminal://exit, which every mounted view of this id hears.
ReaderEof(g) ==
  /\ g \in eof
  /\ eof' = eof \ {g}
  /\ IF map = g
     THEN /\ map' = 0
          /\ view' = [v \in Views |->
                        IF view[v] \in {"starting", "running"} THEN "exited" ELSE view[v]]
     ELSE UNCHANGED <<map, view>>
  /\ UNCHANGED <<replied, start, kills, alive>>

Next ==
  \/ \E v \in Views : Mount(v) \/ Unmount(v) \/ Reply(v) \/ StartKill(v) \/ StartInsert(v)
  \/ \E k \in kills : TermKill(k)
  \/ \E g \in alive : ShellExits(g)
  \/ \E g \in eof : ReaderEof(g)

Spec == Init /\ [][Next]_vars

\* --- properties ------------------------------------------------------------

TypeOK ==
  /\ view \in [Views -> {"idle", "starting", "running", "exited", "gone"}]
  /\ start \in [Views -> {"none", "kill", "insert", "reply", "done"}]
  /\ map \in Views \cup {0}
  /\ alive \subseteq Views /\ eof \subseteq Views

Settled ==
  /\ \A v \in Views : start[v] \in {"none", "done"}
  /\ kills = {} /\ eof = {}

\* A pane that shows a running shell has one: no pane is left silently dead,
\* its shell killed with no terminal://exit to say so.
PaneHasShell ==
  Settled => \A v \in Views : view[v] = "running" => map = v /\ v \in alive

\* No shell outlives every pane: each running process is the one the map owns.
NoOrphanShell == Settled => alive \subseteq {map}
====
