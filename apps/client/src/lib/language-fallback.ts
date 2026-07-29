/**
 * Second-chance language resolution for Monaco models.
 *
 * The grammars in `lib/monaco.ts` are VS Code's own built-in language
 * extensions, and Monaco resolves a model's language from its URI against
 * their `contributes.languages` file associations. Anything they don't claim
 * lands on `plaintext` — which still *renders* (a diff of an unknown type is
 * never blank), it just has no colors.
 *
 * Two gaps that leaves, and this table closes:
 *
 * - **A type VS Code has no built-in grammar for at all.** TOML is the one
 *   that matters here — `Cargo.toml`, `comment-lint.toml`, every workspace
 *   manifest in this repo — and upstream ships it as a marketplace extension,
 *   so there is nothing to install from `@codingame/monaco-vscode-*`. It reads
 *   well enough under the INI grammar (`# comment`, `[section]`, `key = value`
 *   are the same shapes) that borrowing it beats plain white text.
 * - **A name the association list misses.** Tool-specific dotfiles and
 *   lockfiles whose syntax is plainly some language VS Code *does* ship.
 *
 * Applied only when Monaco's own answer was `plaintext`, so a grammar
 * arriving later (an extension package added upstream, a new association)
 * silently wins over the guess here with no edit to this file.
 */

/** Monaco's id for "no grammar matched" — the only state worth overriding. */
const PLAINTEXT = "plaintext";

/**
 * Exact file names, checked before extensions. Keys are compared
 * case-sensitively except where the convention itself is case-insensitive.
 */
const BY_NAME: Record<string, string> = {
  "Cargo.lock": "ini",
  "uv.lock": "ini",
  "poetry.lock": "ini",
  Pipfile: "ini",
  ".editorconfig": "ini",
  ".gitconfig": "ini",
  ".npmrc": "ini",
  ".flake8": "ini",
  "setup.cfg": "ini",
  "tox.ini": "ini",
  ".babelrc": "json",
  ".prettierrc": "json",
  ".eslintrc": "json",
  ".swcrc": "json",
  Brewfile: "ruby",
  Vagrantfile: "ruby",
  Justfile: "makefile",
  justfile: "makefile",
  ".env": "ini",
};

/** Extensions (no dot, lowercased) → the grammar that reads them best. */
const BY_EXTENSION: Record<string, string> = {
  // No built-in TOML grammar upstream; INI is the closest shape.
  toml: "ini",
  cfg: "ini",
  conf: "ini",
  ini: "ini",
  properties: "ini",
  // Shells and their dotfile spellings.
  zsh: "shellscript",
  bash: "shellscript",
  fish: "shellscript",
  zshrc: "shellscript",
  bashrc: "shellscript",
  profile: "shellscript",
  // Config dialects that are really another language.
  jsonc: "json",
  json5: "json",
  webmanifest: "json",
  har: "json",
  yamllint: "yaml",
  // Markup/templating variants VS Code's associations don't list.
  mdx: "markdown",
  markdown: "markdown",
  svg: "xml",
  xsd: "xml",
  xsl: "xml",
  plist: "xml",
  storyboard: "xml",
  csproj: "xml",
  props: "xml",
  targets: "xml",
  // Sources whose extension aliases a grammar already installed.
  pyi: "python",
  ipynb: "json",
  mk: "makefile",
};

/** Name *prefixes* — `.env.local`, `Dockerfile.dev`, `Makefile.am`. */
const BY_PREFIX: Array<[string, string]> = [
  [".env.", "ini"],
  ["Dockerfile", "dockerfile"],
  ["Containerfile", "dockerfile"],
  ["Makefile", "makefile"],
  ["makefile", "makefile"],
];

/**
 * The language to use for `path` when Monaco found none, or null to leave it
 * as plaintext. Takes a path or a bare file name.
 */
export function fallbackLanguageFor(path: string): string | null {
  const name = path.split("/").pop() ?? path;
  const byName = BY_NAME[name];
  if (byName != null) return byName;
  for (const [prefix, language] of BY_PREFIX) {
    if (name.startsWith(prefix)) return language;
  }
  const dot = name.lastIndexOf(".");
  // `lastIndexOf` on a leading-dot name ("`.zshrc`") still finds index 0 —
  // the extension is the whole rest, which is what the table keys on.
  if (dot < 0) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

type Monaco = typeof import("monaco-editor");
type TextModel = import("monaco-editor").editor.ITextModel;

/**
 * Give `model` a language if Monaco's URI-based resolution came up empty and
 * this file knows a better answer. No-op otherwise.
 *
 * Deliberately does **not** check that the id is registered first. The
 * built-in language extensions register asynchronously after `api.initialize`
 * resolves, so `monaco.languages.getLanguages()` is still short of them the
 * first time a pane builds its models — guarding on it left every `.toml`
 * plaintext for the life of the window (measured: `known=false` for `ini` on
 * the first diff after a reload). Setting an id the language service hasn't
 * seen yet is safe: it resolves lazily and re-tokenizes when the grammar
 * arrives.
 */
export function applyLanguageFallback(monaco: Monaco, model: TextModel, path: string): void {
  if (model.getLanguageId() !== PLAINTEXT) return;
  const language = fallbackLanguageFor(path);
  if (language == null) return;
  monaco.editor.setModelLanguage(model, language);
}
