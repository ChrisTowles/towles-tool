# Client state

`apps/client` keeps every piece of state that more than one component reads, or
that a backend event changes, in an [Effect](https://effect.website) atom
(`effect/reactivity/Atom`) held by one registry. Components read atoms; they never
copy them. This page is the contract the code comments point at.

## Why

The bugs this replaced were all one shape: two copies of a value that drifted.
A `useState` seeded from a snapshot once, a ref mirrored on every render so a
mount-only handler could read it, an effect that "repaired" state after the
fact (pruning windows, re-pointing the cursor), a context whose provider and
consumer disagreed about when a value changed. Each copy is a chance for the
rail, the panes and an animation key to disagree for a frame — or for good.

The rules below remove the copies. A value has one owner, everything else is
derived from it at read time, and a handler reads the owner at call time.

## The pieces

| File | What it is |
|---|---|
| `lib/atoms/registry.ts` | `appRegistry`, `read(atom)`, `write(atom, v)`, `appEffect`, `startAppEffects` |
| `lib/atoms/feed.ts` | `feed(name, body)` — an app-lifetime backend subscription; `onEvent` wraps Tauri `listen` |
| `lib/atoms/persisted.ts` | `persistedAtom(key, schema, fallback)` — a writable atom backed by localStorage |
| `lib/atoms/react.ts` | `useAtomValue`, and `useAtomEffect` for DOM side effects at the React edge |
| `lib/board/` | Agent Board's UI: `model.ts` (the record + `normalize`), `atoms.ts` (its one writer), `derive.ts` (everything shown), `commands.ts`, `selection.ts`, `cursor.ts` |

`main.tsx` wraps the app in `RegistryContext.Provider value={appRegistry}` and
calls `startAppEffects()` once, which mounts every `feed` and `appEffect`. Tests
never start them: `test/render.tsx` resets the registry after each test, and a
test feeds state in directly (`acceptAgentboard(payload)`).

## The rules

1. **One owner per value.** A backend snapshot is owned by its feed atom
   (`agentboardAtom`, `taskQueueAtom`, `storeSnapshotAtom`, `userSettingsAtom`).
   UI state is owned by a writable atom. Nothing else stores a copy.
2. **One writer per atom.** A state atom changes through a reducer
   (`updateAgentboard`, `updateTabs`) or a transition (`dispatchBoard(t)`), never
   through ad-hoc `set` calls scattered across components. Agent Board's record
   goes through `boardUiAtom`'s writer, which applies `normalize`, so an invariant
   such as "the selection is inside the checkout on screen" holds after every
   write however it was made.
3. **Derive, don't sync.** Anything computable from owned values is a derived
   atom (`Atom.make(get => …)`): the rail's rows, the cursor, the window layout,
   the fold map, the queue ring. A derived atom whose result is unchanged
   (`Object.is`) wakes nobody, so split atoms by dependency to keep identities
   stable. **An effect that writes state in response to state is a bug**; the
   value it writes should be derived.
4. **Read at call time.** A handler, timer or async continuation calls
   `read(atom)` when it runs. No ref mirrors (`fooRef.current = foo`). Where a
   helper is written against `ref.current`, pass a live view (`railRef`,
   `cwdsRef`) whose getter reads the atom.
5. **Effects are for the outside world.** A feed subscribes to Tauri; an atom
   with `get.addFinalizer` owns a timer or a DOM listener only while it is read
   (`inboxAtom`, `windowFocusedAtom`, `freshHudNoteAtom`); `useAtomEffect` moves
   DOM focus or scrolls. None of them write state that could be derived.
6. **Global atoms are `keepAlive`.** Without it the registry drops an atom once
   no component reads it, and a remount starts from the initial value.
7. **Optimistic overlays live in the model** and are settled by a pure function
   (`settleOverlays`) when a snapshot agrees, or by a backstop timer.

## What may stay in `useState`

Leaf view state that no other component reads and no backend changes: an
input's text, a hover, whether a menu or dialog is open, a form's draft. If a
second component needs it, or it must survive the component unmounting, it
becomes an atom.

## The lint gate

`.oxlintrc.json` enforces the shape:

- `useSyncExternalStore`, `useReducer`, `createContext` and `useContext` are
  banned app-wide (outside `lib/atoms/react.ts`): no hand-rolled stores.
- `lib/board/**`, `lib/agentboard/**` and the atom spine may not import React.
- Agent Board's screen and rails (`screens/agentboard.tsx`, `pane-grid.tsx`,
  `checkout-tree.tsx`, `components/queue-rail.tsx`) may not call `useState`.

## Cursors when a row disappears

The tree's cursor is stored as the node it was put on. `cursorNodeAtom`
resolves it against today's rows: its own row, else what now stands for it
(`resolveCursor`: a folded session's checkout, a folded checkout's repo), else
the row now at its old position, else the first. The queue ring follows the
checkout on screen; when that checkout's row goes, it lands on the row at the
same index in the same lane, else the first row. Both are derived with the
previous slot (`get.self()`), so no write repairs them.

## Testing

`lib/board/invariants.test.ts` drives the real atoms through seeded random
walks — snapshots arriving, stale clicks, folds, cursor moves, panes opened and
closed — and checks after every step: the record is normalized, the selection is
in the checkout on screen, tree keys are unique, the cursor is on a row, every
jump digit names a row, a fold never hides the checkout on screen, and no pane
names a session that does not exist.
