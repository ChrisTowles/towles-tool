---- MODULE PtyStatus ----
\* PTY-first agent status: crates/tt-agentboard/src/pty_status.rs over the
\* stamps PtyActivity writes in crates-tauri/tt-app/src/terminal/session.rs.
\* One tick is 500ms; 0 means "never happened", as the AtomicI64 stamps do, so
\* time starts at 1. The agent's real phase is ghost state the code cannot see:
\* the properties ask whether the status the code derives tells the truth.
EXTENDS Naturals

CONSTANTS
  ActiveTicks,     \* OUTPUT_ACTIVE_MS / tick
  SustainTicks,    \* SUSTAINED_OUTPUT_MS / tick
  GraceTicks,      \* ATTENTION_GRACE_MS / tick
  TwitchGap,       \* fewest ticks between a finished pane's idle repaints
  SinceFirst,      \* note_output's store order (see NoteOutput)
  MaxT

VARIABLES now, lastOut, outSince, attnAt, inputAt, agent, phaseSince, framed, pend

vars == <<now, lastOut, outSince, attnAt, inputAt, agent, phaseSince, framed, pend>>
Stamp == 0..MaxT

\* --- the code under test, transcribed -----------------------------------

\* PtySignal::sustained_run
Sustained == lastOut /= 0 /\ outSince /= 0 /\ lastOut - outSince >= SustainTicks
\* PtySignal::output_active
OutputActive == lastOut /= 0 /\ now - lastOut < ActiveTicks /\ Sustained
\* PtySignal::attention_pending
AttentionPending ==
  /\ attnAt /= 0
  /\ ~(inputAt /= 0 /\ inputAt >= attnAt)
  /\ ~(outSince > attnAt + GraceTicks /\ Sustained)
  /\ ~OutputActive

\* resolve_status, for a journal verdict of Idle with no background agents
Status == IF OutputActive THEN "Busy"
          ELSE IF AttentionPending THEN "Waiting"
          ELSE "Idle"

\* PtyActivity::note_output: a frame after a gap of ActiveTicks starts a run.
\* The two stamps are separate Relaxed atomics, so the emit loop can read
\* between the writes; `pend` holds the second one. SinceFirst writes a fresh
\* run's start before last_output_ms, else last_output_ms goes first.
FreshRun == lastOut = 0 \/ now - lastOut >= ActiveTicks

NoteOutput ==
  IF SinceFirst
  THEN /\ outSince' = IF FreshRun THEN now ELSE outSince
       /\ pend' = now
       /\ UNCHANGED lastOut
  ELSE /\ lastOut' = now
       /\ pend' = IF FreshRun THEN now ELSE 0
       /\ UNCHANGED outSince

\* The vt sink's second store.
NoteOutputEnd ==
  /\ pend /= 0
  /\ IF SinceFirst
     THEN lastOut' = pend /\ UNCHANGED outSince
     ELSE outSince' = pend /\ UNCHANGED lastOut
  /\ pend' = 0
  /\ UNCHANGED <<now, attnAt, inputAt, agent, phaseSince, framed>>

\* --- the agent and the user ---------------------------------------------

Init ==
  /\ now = 1
  /\ lastOut = 0 /\ outSince = 0 /\ attnAt = 0 /\ inputAt = 0
  /\ agent = "idle" /\ phaseSince = 1
  /\ framed = FALSE /\ pend = 0

\* Mid-turn Claude Code animates an elapsed counter: a frame every tick
\* (measured pauses top out at 0.27s).
WorkFrame ==
  /\ agent = "working" /\ ~framed /\ pend = 0
  /\ NoteOutput
  /\ framed' = TRUE
  /\ UNCHANGED <<now, attnAt, inputAt, agent, phaseSince>>

\* A finished or blocked pane still repaints now and then; right after the
\* notification its own trailing repaint lands within a tick.
Twitch ==
  /\ agent \in {"idle", "asking"} /\ ~framed /\ pend = 0
  /\ \/ lastOut = 0
     \/ now - lastOut >= TwitchGap
     \/ agent = "asking" /\ now - attnAt <= 1
  /\ NoteOutput
  /\ framed' = TRUE
  /\ UNCHANGED <<now, attnAt, inputAt, agent, phaseSince>>

\* The turn ends blocked on the user: OSC 777 / bell stamps attention_at_ms.
\* A turn lasts at least a tick, so the input that began it stamps earlier.
Ask ==
  /\ agent = "working" /\ now > phaseSince
  /\ attnAt' = now
  /\ agent' = "asking" /\ phaseSince' = now
  /\ UNCHANGED <<now, lastOut, outSince, inputAt, framed, pend>>

\* The user types into the pane (terminal/input.rs stamps input_at_ms) and
\* the agent starts a turn.
Answer ==
  /\ agent \in {"idle", "asking"}
  /\ inputAt' = now
  /\ agent' = "working" /\ phaseSince' = now
  /\ UNCHANGED <<now, lastOut, outSince, attnAt, framed, pend>>

\* The agent gets going again with no input (a prompt resolved elsewhere).
Resume ==
  /\ agent = "asking"
  /\ agent' = "working" /\ phaseSince' = now
  /\ UNCHANGED <<now, lastOut, outSince, attnAt, inputAt, framed, pend>>

\* The turn ends without asking anything.
Finish ==
  /\ agent = "working"
  /\ agent' = "idle" /\ phaseSince' = now
  /\ UNCHANGED <<now, lastOut, outSince, attnAt, inputAt, framed, pend>>

Tick ==
  /\ now < MaxT /\ pend = 0
  /\ agent = "working" => framed
  /\ now' = now + 1
  /\ framed' = FALSE
  /\ UNCHANGED <<lastOut, outSince, attnAt, inputAt, agent, phaseSince, pend>>

Next ==
  WorkFrame \/ NoteOutputEnd \/ Twitch \/ Ask \/ Answer \/ Resume \/ Finish \/ Tick
Spec == Init /\ [][Next]_vars

\* --- what the status must get right -------------------------------------

TypeOK ==
  /\ now \in 1..MaxT
  /\ {lastOut, outSince, attnAt, inputAt} \subseteq Stamp
  /\ agent \in {"idle", "working", "asking"}
  /\ phaseSince \in 1..MaxT
  /\ framed \in BOOLEAN /\ pend \in Stamp

\* A turn that has been painting for a second shows Busy.
WorkShowsBusy ==
  (agent = "working" /\ lastOut = now /\ outSince /= 0
   /\ now - outSince >= SustainTicks) => Status = "Busy"

\* Once the notification's trailing repaint has aged out (it may extend the
\* turn's last run, as a_full_turn_walks_idle_busy_waiting_idle pins), a
\* blocked agent shows Waiting for as long as it stays unanswered: idle
\* repaints must neither flicker it to Busy nor clear it.
AskingShowsWaiting ==
  (agent = "asking" /\ now - phaseSince > ActiveTicks) => Status = "Waiting"

\* A finished pane's idle repaints never read as work.
IdleIsNotBusy ==
  (agent = "idle" /\ now - phaseSince >= ActiveTicks) => Status /= "Busy"

\* Typing into the pane answers it.
AnswerClears == (inputAt /= 0 /\ inputAt >= attnAt) => ~AttentionPending
====
