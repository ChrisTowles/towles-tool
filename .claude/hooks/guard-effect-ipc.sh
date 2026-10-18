#!/usr/bin/env bash
#
# PostToolUse guard: keep client IPC on the Effect path.
#
# `apps/client/src/lib/tauri.ts` is the single IPC boundary: `invoke` returns a
# lazy `Effect<A, IpcError>` and never throws. An Effect that is never run is a
# silent no-op, so the failure this guards against is the old habit surviving
# the cutover: `void invoke(...)` (does nothing now), a `.catch` on a promise
# that cannot reject, a raw Tauri `listen`/`setInterval` that skips the scoped
# helpers, or a better-result/zod import creeping back. None of that breaks the
# build, which is exactly why it needs a check.
#
# Advisory only — it appends context rather than blocking, because every
# pattern here has a legitimate exception. Like every hook here it fails open:
# any parse problem exits 0.

set -uo pipefail

input=$(cat) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
[ -n "$file" ] || exit 0
[ -f "$file" ] || exit 0

case "$file" in
  *apps/client/src/*.ts | *apps/client/src/*.tsx) scope=client ;;
  *scripts/*.mjs) scope=scripts ;;
  *) exit 0 ;;
esac

findings=""
add() { findings="${findings}${findings:+
}$1
$2"; }

# Drop comment/doc lines — these checks key on syntax, and prose that merely
# names a discouraged pattern (including this repo's own docstrings explaining
# why it is discouraged) is not a violation.
code_only() { grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*)'; }

# The four wrappers this repo deliberately collapsed into one `invoke`. Their
# differing failure semantics were the original footgun; a new one reopens it.
hits=$(grep -nE '\<(invokeCmd|invokeOrThrow|invokeToast|invokeOk)\>' "$file" 2>/dev/null | code_only | head -3)
[ -n "$hits" ] && add "Resurrected invoke wrapper:" "$hits"

# oxlint's no-underscore-dangle rejects `._tag` as an error; the tagged-error
# classes expose a type guard for this.
hits=$(grep -nE '\._tag[[:space:]]*[!=]==' "$file" 2>/dev/null | code_only | head -3)
[ -n "$hits" ] && add "Raw ._tag comparison — use the class guard, e.g. NotInTauri.is(e):" "$hits"

if [ "$scope" = client ]; then
  # `String(e)` degrades to "[object Object]" on a rejected Tauri command
  # (Tauri rejects with a bare string). `lib/errors.ts` defines errorMessage.
  case "$file" in
    *apps/client/src/lib/errors.ts) ;;
    *)
      hits=$(grep -nE '\<String\((e|err|error|ex|cause)\)' "$file" 2>/dev/null | code_only | head -3)
      [ -n "$hits" ] && add "String() on an error — use errorMessage() from @/lib/errors:" "$hits"
      ;;
  esac

  # A statement-position `invoke(...)` builds an Effect and drops it.
  hits=$(grep -nE '^[0-9]+:[[:space:]]*(void[[:space:]]+)?invoke[<(]' "$file" 2>/dev/null | code_only | head -3)
  [ -n "$hits" ] && add "Un-run invoke — it is a lazy Effect; wrap it in fire()/runIpc()/ipcOr():" "$hits"

  # Dead error plumbing: these resolve, they never reject.
  hits=$(grep -nE '(runIpc|ipcOr)\(.*\)[[:space:]]*\.catch|fire\(.*\)[[:space:]]*\.' "$file" 2>/dev/null | code_only | head -3)
  [ -n "$hits" ] && add "Dead .catch — runIpc/ipcOr never reject and fire() returns void:" "$hits"

  # Tauri entry points other than the helpers that own teardown.
  case "$file" in
    *apps/client/src/lib/tauri.ts | *apps/client/src/lib/events.ts | *apps/client/src/lib/subscribe-then.ts | *.test.ts | *.test.tsx) ;;
    *)
      hits=$(grep -nE '@tauri-apps/api/(core|event)' "$file" 2>/dev/null | code_only | head -3)
      [ -n "$hits" ] && add "Direct Tauri import bypasses the Effect boundary (invoke in lib/tauri.ts; events via subscribe/useTauriEvent in lib/run.ts):" "$hits"
      ;;
  esac

  # Pollers and subscriptions have one scoped home.
  case "$file" in
    *apps/client/src/lib/now.tsx | *apps/client/src/components/agentboard-bits/diff-chips.tsx) ;;
    *)
      hits=$(grep -nE '\<setInterval\(' "$file" 2>/dev/null | code_only | head -3)
      [ -n "$hits" ] && add "setInterval — poll IPC with usePoll/startPoll (lib/run.ts); clock ticks are the exception:" "$hits"
      ;;
  esac

  # Running effects by hand skips the helpers' guarantees.
  case "$file" in
    *apps/client/src/lib/tauri.ts | *apps/client/src/lib/run.ts) ;;
    *)
      hits=$(grep -nE 'Effect\.run(Promise|Fork|Sync)' "$file" 2>/dev/null | code_only | head -3)
      [ -n "$hits" ] && add "Effect.run* at a call site — use runIpc / fire / start from lib:" "$hits"
      ;;
  esac

  hits=$(grep -nE "from \"(better-result|zod)\"" "$file" 2>/dev/null | code_only | head -3)
  [ -n "$hits" ] && add "better-result/zod are gone — Effect Result and Schema:" "$hits"
fi

[ -n "$findings" ] || exit 0

reason="Effect IPC convention drift in ${file}:

${findings}

apps/client/src/lib/tauri.ts's \`invoke\` returns a lazy Effect<A, IpcError> and never
throws — every failure (no Tauri host, rejected command, schema mismatch, timeout) is a
typed error. Nothing happens until it is run: runIpc(e) gives a Promise<Result> that never
rejects, ipcOr(e, fallback) degrades, fire(e) is fire-and-forget. Handle the outcome at
the call site (Result.isFailure / Result.match). Events: subscribe / useTauriEvent;
polling: usePoll / startPoll (lib/run.ts).

Ignore any line above where the exception is real: a genuinely throwing foreign API
(navigator.clipboard, a Monaco dispose) still needs .catch, and String() on a non-error
value is fine."

jq -n --arg r "$reason" \
  '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$r}}' 2>/dev/null || exit 0
exit 0
