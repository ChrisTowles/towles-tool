/** Fence language → Monaco language id for the Markdown preview. Fences use
 * short aliases that are not VS Code language ids, and Monaco silently renders
 * an unknown id as plaintext — a wrong mapping looks like broken highlighting
 * with no error anywhere. Ids not listed here are already correct. */

const ALIASES: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  // `shell` and `bash` are aliases, not ids — the grammar registers as
  // `shellscript`, and the other two render as plaintext.
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  console: "shellscript",
  yml: "yaml",
  md: "markdown",
};

/** `className` is what react-markdown puts on `<code>` (`language-ts`); a fence
 * with no language has none, hence null. */
export function monacoLanguageFor(className: string | undefined): string | null {
  const match = /(?:^|\s)language-([\w+-]+)/.exec(className ?? "");
  if (!match) return null;
  const lang = match[1].toLowerCase();
  return ALIASES[lang] ?? lang;
}
