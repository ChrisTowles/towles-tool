import * as Atom from "effect/reactivity/Atom";

/** Whether the app window has focus; listens only while something reads it. */
export const windowFocusedAtom: Atom.Atom<boolean> = Atom.make((get) => {
  const onChange = () => get.setSelf(document.hasFocus());
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  get.addFinalizer(() => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
  });
  return document.hasFocus();
});
