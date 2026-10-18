import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createStore, useStoreSelector, type Store } from "./external-store";
import { replaceEqualDeep } from "./replace-equal-deep";
import { Effect } from "effect";
import { subscribeThen } from "./subscribe-then";
import { invoke, isTauri } from "./tauri";
import {
  EMPTY_SNAPSHOT,
  mockSnapshot,
  toStoreSnapshot,
  type StoreSnapshot,
  type WireStoreSnapshot,
} from "./data";

/** A single app-wide subscription to the live store snapshot: screens stay
 * mounted, so ~14 consumers each listening meant ~14 parses per event. Empty
 * with `live` false until the store answers, {@link mockSnapshot} outside Tauri.
 * Each event is merged into the held snapshot so an unchanged list keeps its
 * identity, and one that changed nothing wakes no reader. */
type StoreSnapshotValue = { snapshot: StoreSnapshot; live: boolean };

type SnapshotStore = { snapshot: Store<StoreSnapshot>; live: Store<boolean> };

const StoreSnapshotContext = createContext<SnapshotStore | null>(null);

export function StoreSnapshotProvider({ children }: { children: ReactNode }) {
  const [store] = useState<SnapshotStore>(() => ({
    snapshot: createStore(EMPTY_SNAPSHOT),
    live: createStore(false),
  }));

  useEffect(() => {
    const setSnapshot = (next: StoreSnapshot) =>
      store.snapshot.set(replaceEqualDeep(store.snapshot.get(), next));
    const setLive = store.live.set;

    if (!isTauri()) {
      // Browser dev: render mock rows so screens are visually workable.
      setSnapshot(mockSnapshot());
      return;
    }
    // A `store://snapshot` event can beat the initial `store_snapshot` invoke;
    // once one has, its data is fresher, so don't let the invoke roll it back.
    let eventArrived = false;
    const apply = (wire: WireStoreSnapshot) => {
      setSnapshot(toStoreSnapshot(wire));
      setLive(true);
    };
    return subscribeThen(
      {
        "store://snapshot": (payload) => {
          eventArrived = true;
          apply(payload as WireStoreSnapshot);
        },
      },
      invoke<WireStoreSnapshot>("store_snapshot").pipe(
        Effect.tap((initial) => Effect.sync(() => eventArrived || apply(initial))),
        Effect.ignore,
      ),
    );
  }, [store]);

  return <StoreSnapshotContext.Provider value={store}>{children}</StoreSnapshotContext.Provider>;
}

/** The live store snapshot and whether the real store has answered yet. Must be
 * used under a {@link StoreSnapshotProvider}. */
export function useStoreSnapshot(): StoreSnapshotValue {
  const ctx = useSnapshotStore();
  const snapshot = useStoreSelector(ctx.snapshot, (s) => s);
  const live = useStoreSelector(ctx.live, (l) => l);
  return useMemo(() => ({ snapshot, live }), [snapshot, live]);
}

function useSnapshotStore(): SnapshotStore {
  const ctx = useContext(StoreSnapshotContext);
  if (ctx === null) {
    throw new Error("useStoreSnapshot must be used within a StoreSnapshotProvider");
  }
  return ctx;
}
