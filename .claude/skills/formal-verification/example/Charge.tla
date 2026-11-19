---- MODULE Charge ----
\* A client charges a card through a server and retries when the reply is lost.
\* Promise: the card is charged at most once, and the client eventually learns the charge went through.
EXTENDS Naturals

CONSTANTS
  Idempotent,   \* TRUE: the server remembers the request key and does not charge again
  MaxSends      \* bound on how many times the client sends the request

VARIABLES
  sent,         \* how many times the client has sent the request
  inFlight,     \* requests on the wire, not yet handled by the server
  charges,      \* how many times the card was charged
  seen,         \* the server has recorded the request key
  replies,      \* replies on the wire, not yet read by the client
  confirmed     \* the client knows the charge went through

vars == <<sent, inFlight, charges, seen, replies, confirmed>>

Init ==
  /\ sent = 0 /\ inFlight = 0 /\ charges = 0
  /\ seen = FALSE /\ replies = 0 /\ confirmed = FALSE

\* The client sends the request: the first time, or again after a timeout.
Send ==
  /\ ~confirmed /\ sent < MaxSends
  /\ sent' = sent + 1 /\ inFlight' = inFlight + 1
  /\ UNCHANGED <<charges, seen, replies, confirmed>>

\* The server handles one request and replies.
Handle ==
  /\ inFlight > 0
  /\ inFlight' = inFlight - 1
  /\ charges' = IF Idempotent /\ seen THEN charges ELSE charges + 1
  /\ seen' = TRUE
  /\ replies' = replies + 1
  /\ UNCHANGED <<sent, confirmed>>

\* The network loses a reply. It never loses the last one the client can still get.
LoseReply ==
  /\ replies > 0 /\ (sent < MaxSends \/ inFlight + replies > 1)
  /\ replies' = replies - 1
  /\ UNCHANGED <<sent, inFlight, charges, seen, confirmed>>

\* The client reads a reply.
Receive ==
  /\ replies > 0
  /\ replies' = replies - 1 /\ confirmed' = TRUE
  /\ UNCHANGED <<sent, inFlight, charges, seen>>

Next == Send \/ Handle \/ LoseReply \/ Receive

Spec == Init /\ [][Next]_vars /\ WF_vars(Send) /\ WF_vars(Handle) /\ WF_vars(Receive)

TypeOK ==
  /\ sent \in 0..MaxSends /\ inFlight \in 0..MaxSends /\ replies \in 0..MaxSends
  /\ charges \in 0..MaxSends /\ seen \in BOOLEAN /\ confirmed \in BOOLEAN

ChargedAtMostOnce == charges <= 1
EventuallyConfirmed == <>confirmed
====
