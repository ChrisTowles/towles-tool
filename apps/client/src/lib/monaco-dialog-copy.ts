/** Presentation helpers for the confirmations the VS Code layer raises. Kept
 * apart from `monaco-dialogs.ts`, which pulls in the whole
 * `@codingame/monaco-vscode-api` graph that a logic-only vitest run can't
 * load — this file stays importable by tests. */

/** VS Code writes mnemonics as `&&Delete`; show a plain label. */
export function stripMnemonic(label: string): string {
  return label.replace(/&&/g, "");
}

/** Make the delete confirmation tell the truth: `OverlayFileSystemProvider`
 * drops the `Trash` capability, so VS Code says "permanently delete" while our
 * provider trashes anyway (`monaco-fs.ts`). Narrow on purpose — an unrelated
 * confirmation passes through untouched. */
export function deleteCopyForTrash(
  message: string,
  detail: string | undefined,
): { message: string; detail?: string } {
  if (!/permanently delete/i.test(message)) return { message, detail };
  return {
    message: message.replace(/permanently delete/gi, "delete"),
    detail: "You can restore it from your system Trash.",
  };
}

/** Destructive actions get the destructive button. VS Code doesn't tag
 * confirmations with a severity we can trust here, so key off the verb the
 * action put on its own primary button. */
export function isDangerous(primary: string, message: string): boolean {
  return /delete|remove|discard|trash/i.test(`${primary} ${message}`);
}
