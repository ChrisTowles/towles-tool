---
name: formal-verification
description: "Model-check a design with TLA+ and everystate (no Java needed): write a small model of the code, check every reachable state, and report any counterexample in the code's own words. Use for races, retries, timeouts, locks, leases, queues, state machines, distributed protocols, or when asked to \"model-check this\", \"prove this invariant\", or \"can these steps happen in a bad order?\"."
---

# Formal verification with everystate

A test checks the cases someone thought to write. A model checker checks every order of steps in a
small model of the design. Use it when the question is "can these events happen in an order that
breaks a promise?" and the answer depends on interleavings that tests rarely reach.

It verifies the model, not the code. It does not answer "is this function correct for every input";
use property-based tests or a verifier that runs on the code for that. To check that the running
code behaves like the model, record a run and use `everystate conform` (see "Check the real code
against the model" below).

## The tool

`everystate` is a TLA+ model checker with TLC's command line, output and exit codes, as one binary.

```sh
npx everystate Spec.tla                       # reads Spec.cfg next to it
npx everystate -config Other.cfg Spec.tla     # another configuration of the same spec
npx everystate -json Spec.tla                 # one JSON object on the last line of stdout
```

| Exit | Meaning |
|---|---|
| 0 | every reachable state checked, nothing found |
| 10 | an `ASSUME` is false |
| 11 | deadlock: a state with no next step |
| 12 | an invariant is violated |
| 13 | a liveness property is violated |
| 150 / 151 | the spec / the `.cfg` does not parse |

The JSON object has `status` (`ok`, `invariant`, `liveness`, `deadlock`, ...), the state counts, and
on a failure `name` and `trace`: the shortest list of `{action, state}` steps that reaches it.

Also available: `everystate pcal Spec.tla` translates a PlusCal algorithm in the module (same output
as the Java translator), and `everystate -simulate num=10000 Spec.tla` checks random behaviours
when a model is too large to enumerate (a pass then covers only the behaviours generated).

Add `-workers auto` to search on every core (same results). Not supported: TLAPS proofs. Exhaustive checking needs a model that is finite and
small enough to enumerate; a few million states is fine.

## How to do it

1. **Pick the promise.** One sentence the code is supposed to keep, where a break harms users: "a
   card is charged at most once", "two workers never hold the same lease". Read the code first and
   take the promise from it; ask the user only what you cannot see.
2. **Model the steps, not the code.** One variable per piece of state that matters, one action per
   step that can interleave with others. What the model treats as one step must be one indivisible
   step in the code: a read followed by a write is two actions unless a lock or transaction makes
   it one. Include the failures: lost messages, timeouts, crashes, retries. Use the code's names,
   and put a comment on each action saying which function it stands for.
3. **Bound it.** Constants in the `.cfg` keep the model finite (2 or 3 workers, 3 retries). Most
   design bugs show up at these sizes.
4. **State the properties.** A type invariant first, since it catches modelling mistakes. Then the
   promise as an `INVARIANT` ("never bad") or a `PROPERTY` ("eventually good", which needs fairness
   in `Spec`).
5. **Run it and read the result.** On a violation, retell the trace as a short story in the code's
   words. Then decide: is this a real bug, or did the model allow a step the code cannot take?
   Check against the code before changing either.
6. **See it fail.** A check that has never failed proves nothing. Break the model the way the code
   could be broken (remove the guard, reorder two steps) and confirm the checker reports it. Keep
   that as a second `.cfg` or note the mutation you tried.
7. **Report honestly.** Say what was checked, at which bounds, under which assumptions, and what
   the model leaves out. A pass covers the model at those bounds, not the whole system.

Do not weaken a property or the model to get a pass, and do not change product code unless asked:
a counterexample on the current code is a finding to report.

## Worked example

[`example/Charge.tla`](example/Charge.tla) models a client that retries a card charge when the
reply is lost. The promise is `ChargedAtMostOnce`. The constant `Idempotent` says whether the
server remembers the request key.

```sh
cd example
npx everystate Charge.tla                           # Idempotent = TRUE: exit 0, 29 distinct states
npx everystate -config ChargeBroken.cfg Charge.tla  # Idempotent = FALSE: exit 12
```

The broken configuration fails with this trace, which reads: the client sends, times out and sends
again; the server handles both requests and charges twice.

```
Error: Invariant ChargedAtMostOnce is violated.
State 1: <Initial predicate>   charges = 0, sent = 0
State 2: <Send ...>            sent = 1, inFlight = 1
State 3: <Send ...>            sent = 2, inFlight = 2
State 4: <Handle ...>          charges = 1
State 5: <Handle ...>          charges = 2
```

(Shortened: the real output prints every variable in every state.)

The same spec checks `EventuallyConfirmed`, a liveness property: under weak fairness on sending,
handling and receiving, the client always learns the charge went through.

## Check the real code against the model

A pass says the model keeps the promise. It does not say the code behaves like the model. Trace
conformance closes part of that gap: record what the running code did, then check that the
recording is a behaviour the spec allows. If it is not, the code took a step the model forbids:
a bug in the code, or a model that does not describe it.

```sh
npx everystate conform -trace run.jsonl Spec.tla    # reads Spec.cfg, as for model checking
```

**Record.** Log one JSON line per step of the model, at the place in the code where the step takes
effect, using the model's action and variable names. [`example/observe.ts`](example/observe.ts) is
all it takes:

```ts
export function observe(action: string | null, state: Record<string, unknown>) {
  if (TRACE) appendFileSync(TRACE, JSON.stringify({ ts: Date.now(), action, state }) + '\n');
}
// In the server:  observe('Handle', { charges: await countCharges(key) });
```

**The trace** is JSON Lines (or one JSON array of the same objects). Each observation may have:

| Key | Meaning |
|---|---|
| `action` | name of the spec action that happened. Left out: any action. |
| `params` | the action's arguments, `["w1"]` in order or `{"w": "w1"}` by name, for an action `Lease(w)` under `\E w \in Workers`. |
| `state` | values of some or all variables *after* the step. Variables left out are unconstrained: log what the code knows. |

Other keys (`ts`, `msg`) are ignored, and so are entries with neither `action` nor `state`, so
observations can sit in an ordinary structured log. The first observation is the initial state; if
it names an action, the initial state is taken as unlogged.

**Values** are read according to the type the spec's value has, not guessed from the JSON:

| JSON | matches the TLA+ value |
|---|---|
| `true`, `3`, `"abc"` | the boolean, the integer, the string |
| `"w1"` | also the model value `w1` |
| `[1, 2]` | the sequence `<<1, 2>>` (in order), or the set `{1, 2}` (any order, no duplicates) |
| `{"a": 1}` | the record `[a |-> 1]`, or a function such as `[w \in Workers |-> ...]` with string, model-value or integer keys (`{"1": "x"}`; a sequence is such a function) |
| `{"a": 1, "...": 0}` | a record or function with at least `a |-> 1`: one process logging its own entry |
| `null`, `1.5` | nothing |

Ambiguous on purpose: `[]` matches `<<>>` and `{}`; `{}` matches the empty function, which is
`<<>>`; a string matches a string and a model value of the same name.

| Option | |
|---|---|
| `-hidden N` | up to N steps the log does not show may happen before each observation (default 0: every step is logged) |
| `-stutter` | an observation without `action` may be a snapshot of an unchanged state. Off by default: every line is a step, so a duplicated event is reported instead of absorbed. Use it for logs that sample state. |
| `-behavior` | also print one full behaviour of the spec that matches, with the unlogged variables filled in |
| `-json` | the result as one JSON object: `status`, `failed`, `lastMatched`, `nearest`, `enabled`, `hints` |
| `-limit N`, `-noconstraints` | cap on the spec states tracked at once (default 100000); ignore `CONSTRAINT` bounds |

| Exit | Meaning |
|---|---|
| 0 | the trace is a behaviour of the spec |
| 20 | it is not: the report names the first line that cannot be matched |
| 12 | the spec allows the run, but the run violates an `INVARIANT` of the `.cfg`: the model is wrong |
| 21 / 22 | the trace is malformed / too many candidate states, no verdict |
| 150 / 151 | the spec / the `.cfg` does not parse |

**Worked example.** `example/charge-ok.jsonl` is a run of the charge client and server with one
retry; `example/charge-double.jsonl` is a run where the server charged again on the retry.

```sh
cd example
npx everystate conform -trace charge-ok.jsonl Charge.tla       # exit 0
npx everystate conform -trace charge-double.jsonl Charge.tla   # exit 20
```

```
Trace conforms: 6 observations matched; the recorded run is a behaviour of Charge.
```

```
Error: Trace does not conform to Charge: line 5 (observation 5 of 6) cannot be matched.

  line 5: {"action":"Handle","state":{"charges":2}}
  last matched: line 4 (1 spec state consistent with the trace up to there)
  before this step: charges = 1

Handle can happen here, but it does not produce the observed values.
Closest step the spec allows:
  Handle: charges is 1 in the spec, 2 in the trace
Steps the spec allows here, and the observed variables after each:
  Send       charges = 1
  Handle     charges = 1
  LoseReply  charges = 1
  Receive    charges = 1
```

Read it as: the model says the second `Handle` leaves `charges` at 1 (the server has seen the key),
the code made it 2. Here the code is wrong. Against the model of a server that forgets the key, the
same run is allowed and breaks the promise instead:

```sh
npx everystate conform -trace charge-double.jsonl -config ChargeBroken.cfg Charge.tla   # exit 12
```

```
Error: Invariant ChargedAtMostOnce is violated by the recorded behaviour at line 5.
```

(Shortened: the full output prints the behaviour up to that line.)

**Using it well.**

- On a mismatch, decide against the code which side is wrong, as with a counterexample. If the
  report hints that `-hidden` or `-stutter` would match, the log is missing steps or repeats them:
  fix the logging in preference to loosening the check.
- Observations must be in the order the steps happened. With several processes, write through one
  ordered log, or log per process and check each process's actions separately with `-hidden`.
- The fewer variables logged, the more runs conform. Log the variables the promise is about, and
  name the action.
- A pass covers the runs recorded, on the variables logged. It is a test, not a proof: keep it in
  CI next to the model check, fed by an integration test that exercises retries and failures.

## A `.cfg` in brief

```
SPECIFICATION Spec            \* or INIT Init and NEXT Next
CONSTANTS
  MaxSends = 3
  Workers = {w1, w2}          \* model values
INVARIANTS TypeOK ChargedAtMostOnce
PROPERTY EventuallyConfirmed
CHECK_DEADLOCK FALSE          \* when stopping is a legitimate end
SYMMETRY Perms                \* Perms == Permutations(Workers); safety only
```

## Leaving it for the next change

If the check should outlive this task, commit the spec and `.cfg` next to the code and record with
them: the one command that runs it, which files and functions each action stands for, the bounds,
and the commit at which the model was last confirmed against the code. Whoever changes that code
next can then rerun the check, and can see when the model needs another look.
