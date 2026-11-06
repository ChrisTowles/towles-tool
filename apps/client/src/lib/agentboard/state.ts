// The live agentboard feed: one app-wide subscription into one atom.
// Contract: docs/CLIENT-STATE.md.
import { Effect } from "effect";
import * as Atom from "effect/reactivity/Atom";
import { feed, onEvent } from "@/lib/atoms/feed";
import { write } from "@/lib/atoms/registry";
import { invoke } from "@/lib/tauri";
import { fire } from "@/lib/tauri";
import { OVERLAY_BACKSTOP_MS, type Overlay } from "@/lib/agentboard/overlays";
import {
  INITIAL_AGENTBOARD,
  updateAgentboard,
  type AgentboardModel,
  type AgentboardMsg,
} from "@/lib/agentboard/store";
import type { RepoData, StatePayload } from "@/lib/agentboard/types";

const model = Atom.make<AgentboardModel>(INITIAL_AGENTBOARD).pipe(Atom.keepAlive);

/** Write-only to the feed and to overlay commands; components only read. */
const agentboardModelAtom = Atom.writable(
  (get) => get(model),
  (ctx, msg: AgentboardMsg) => ctx.set(model, updateAgentboard(ctx.get(model), msg)),
).pipe(Atom.keepAlive);

/** The live state with overlays painted, empty until the first snapshot. A
 * subtree no payload touched keeps its identity, so a slice atom over it wakes
 * only when its slice changes. */
export const agentboardAtom = Atom.make((get) => get(agentboardModelAtom).view).pipe(
  Atom.keepAlive,
);

export const reposAtom = Atom.make((get): RepoData[] => get(agentboardAtom).repos).pipe(
  Atom.keepAlive,
);

export const compactRecommendPercentAtom = Atom.make(
  (get) => get(agentboardAtom).compactRecommendPercent,
);

// The initial fetch resolves *after* the listener is live, so a newer event can
// land first; `Accept`'s ts guard keeps it from being rolled back.
/** Take a backend snapshot — the feed's one write, and a test's way in. */
export const acceptAgentboard = (payload: StatePayload): void =>
  write(agentboardModelAtom, { kind: "Accept", payload, now: Date.now() });

feed("agentboard", () =>
  Effect.gen(function* () {
    yield* onEvent("agentboard://state", (p) => acceptAgentboard(p as StatePayload));
    yield* invoke<StatePayload>("ab_get_state").pipe(
      Effect.tap((p) => Effect.sync(() => acceptAgentboard(p))),
      Effect.ignore,
    );
  }),
);

/** Paint `o` over a session app-wide until a snapshot agrees with it; the
 * backstop settles one that never does. */
export function setAgentOverlay(id: string, o: Overlay): void {
  write(agentboardModelAtom, { kind: "SetOverlay", id, overlay: o, now: Date.now() });
  fire(
    Effect.sleep(OVERLAY_BACKSTOP_MS).pipe(
      Effect.andThen(
        Effect.sync(() => write(agentboardModelAtom, { kind: "Settle", now: Date.now() })),
      ),
    ),
  );
}
