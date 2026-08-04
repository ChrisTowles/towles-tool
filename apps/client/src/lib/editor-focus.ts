type Editor = import("monaco-editor").editor.IStandaloneCodeEditor;

/** The last file editor the user was in, so the palette's editor commands have
 * a target after the palette dialog itself has stolen DOM focus. */
let last: Editor | null = null;

/** Call once per created editor; the subscriptions die with it. */
export function trackEditorFocus(editor: Editor): void {
  // A just-created editor is the one being looked at, click or no click.
  last = editor;
  editor.onDidFocusEditorText(() => {
    last = editor;
  });
  editor.onDidDispose(() => {
    if (last === editor) last = null;
  });
}

export function hasLiveEditor(): boolean {
  return last != null;
}

/** Refocus and run a Monaco action ("actions.find", "editor.action.gotoLine"). */
export function runEditorAction(id: string): void {
  const editor = last;
  if (!editor) return;
  editor.focus();
  void editor.getAction(id)?.run();
}
