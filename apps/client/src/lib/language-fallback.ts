/** Second-chance language for a model Monaco resolved to plaintext. TOML is the
 * case that matters — upstream ships it as a marketplace extension, so the INI
 * grammar stands in. A real grammar arriving later silently wins over this. */

const PLAINTEXT = "plaintext";

/** Exact file names, checked before extensions. */
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

/** Keyed on the extension with no dot, lowercased. */
const BY_EXTENSION: Record<string, string> = {
  toml: "ini",
  cfg: "ini",
  conf: "ini",
  ini: "ini",
  properties: "ini",
  zsh: "shellscript",
  bash: "shellscript",
  fish: "shellscript",
  zshrc: "shellscript",
  bashrc: "shellscript",
  profile: "shellscript",
  jsonc: "json",
  json5: "json",
  webmanifest: "json",
  har: "json",
  yamllint: "yaml",
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
  pyi: "python",
  ipynb: "json",
  mk: "makefile",
};

const BY_PREFIX: Array<[string, string]> = [
  [".env.", "ini"],
  ["Dockerfile", "dockerfile"],
  ["Containerfile", "dockerfile"],
  ["Makefile", "makefile"],
  ["makefile", "makefile"],
];

export function fallbackLanguageFor(path: string): string | null {
  const name = path.split("/").pop() ?? path;
  const byName = BY_NAME[name];
  if (byName != null) return byName;
  for (const [prefix, language] of BY_PREFIX) {
    if (name.startsWith(prefix)) return language;
  }
  const dot = name.lastIndexOf(".");
  // On a leading-dot name (`.zshrc`) this finds index 0, so the extension is
  // the whole rest — which is what the table keys on.
  if (dot < 0) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

type Monaco = typeof import("monaco-editor");
type TextModel = import("monaco-editor").editor.ITextModel;

/** Deliberately does **not** check that the id is registered first: built-in
 * grammars register asynchronously after `api.initialize`, so guarding on
 * `getLanguages()` left every `.toml` plaintext for the life of the window.
 * Setting an unregistered id is safe — it re-tokenizes when the grammar lands. */
export function applyLanguageFallback(monaco: Monaco, model: TextModel, path: string): void {
  if (model.getLanguageId() !== PLAINTEXT) return;
  const language = fallbackLanguageFor(path);
  if (language == null) return;
  monaco.editor.setModelLanguage(model, language);
}
