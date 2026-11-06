/** One-shot deep-link primitive for the Settings screen: land on Settings and
 * jump to `tab`, optionally pre-filled with `filter`. */
import * as Atom from "effect/reactivity/Atom";
import { appRegistry } from "./atoms/registry";

export type SettingsTarget = { tab: string; filter?: string };

/** At most one pending settings deep link at a time. */
export const settingsTargetAtom = Atom.make<SettingsTarget | null>(null).pipe(Atom.keepAlive);

/** One-shot read: returns (and clears) the pending target, if any. */
export const consumeSettingsTarget = (): SettingsTarget | null =>
  appRegistry.modify(settingsTargetAtom, (t) => [t, null]);
