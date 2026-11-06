// The live store snapshot: one app-wide subscription into one atom.
// Contract: docs/CLIENT-STATE.md.
import { Effect } from "effect";
import * as Atom from "effect/reactivity/Atom";
import { feed, onEvent } from "./atoms/feed";
import { read, write } from "./atoms/registry";
import { replaceEqualDeep } from "./replace-equal-deep";
import { invoke, isTauri } from "./tauri";
import {
  EMPTY_SNAPSHOT,
  mockSnapshot,
  toStoreSnapshot,
  type StoreSnapshot,
  type WireStoreSnapshot,
} from "./data";

/** Empty with `live` false until the store answers, {@link mockSnapshot}
 * outside Tauri. Each event merges into the held value, so an unchanged list
 * keeps its identity and an event that changed nothing wakes no reader. */
export type StoreSnapshotValue = { snapshot: StoreSnapshot; live: boolean };

const state = Atom.make<StoreSnapshotValue>({ snapshot: EMPTY_SNAPSHOT, live: false }).pipe(
  Atom.keepAlive,
);

export const storeSnapshotAtom: Atom.Atom<StoreSnapshotValue> = state;

const apply = (next: StoreSnapshot, live: boolean) => {
  const prev = read(state);
  const snapshot = replaceEqualDeep(prev.snapshot, next);
  if (snapshot !== prev.snapshot || live !== prev.live) write(state, { snapshot, live });
};

feed("store-snapshot", () =>
  Effect.gen(function* () {
    if (!isTauri()) {
      // Browser dev: render mock rows so screens are visually workable.
      apply(mockSnapshot(), false);
      return;
    }
    // A `store://snapshot` event can beat the initial `store_snapshot` invoke;
    // once one has, its data is fresher, so don't let the invoke roll it back.
    let eventArrived = false;
    yield* onEvent("store://snapshot", (payload) => {
      eventArrived = true;
      apply(toStoreSnapshot(payload as WireStoreSnapshot), true);
    });
    yield* invoke<WireStoreSnapshot>("store_snapshot").pipe(
      Effect.tap((initial) =>
        Effect.sync(() => {
          if (!eventArrived) apply(toStoreSnapshot(initial), true);
        }),
      ),
      Effect.ignore,
    );
  }),
);
