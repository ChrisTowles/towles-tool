import { useEffect, useState } from "react";
import { monacoLanguageFor } from "@/lib/markdown-code";
import { loadedMonaco } from "@/lib/monaco";

/**
 * The markdown fence highlighter: one Monaco tokenizer and, importantly, **one
 * cache**, shared by every renderer that colors code blocks. Today that is the
 * files pane's preview (`file-preview.tsx`), which owns its own react-markdown
 * setup — file-scoped resolution of relative images and links, GitHub alerts,
 * heading anchors, sanitized raw HTML — and imports `MarkdownCode` from here
 * rather than keeping a second copy of the tokenizer and its cache.
 */

/**
 * Tokenized fences, keyed by language + source. Colorizing is a few ms per
 * block, but a preview remounts on every file switch and preview toggle, so
 * without this a 30-fence README re-tokenizes all 30 each time you navigate
 * back to it. Bounded because the values are rendered HTML, not just text.
 */
const COLORIZED = new Map<string, string>();
const COLORIZED_MAX = 200;

/**
 * A fenced code block, tokenized by Monaco.
 *
 * Uses the TextMate grammars and Dark Modern theme the editor already loads,
 * so a snippet in the preview is colored exactly like the same code in the
 * viewer — and it costs no extra dependency (Shiki would ship a second copy of
 * this same stack). Deliberately never *starts* that load: the preview only
 * ever renders beside a CodeViewer, which boots Monaco anyway, and a preview
 * has no business paying a multi-megabyte bootstrap to color a snippet. Plain
 * text is the fallback whenever it isn't up.
 *
 * `dangerouslySetInnerHTML` is safe here specifically because Monaco's
 * colorizer HTML-escapes the source: verified against the running app with
 * `<script>` and `<img onerror=…>` payloads, both of which come back escaped.
 */
function FencedCode({
  language,
  source,
  className,
}: {
  language: string;
  source: string;
  className?: string;
}) {
  // A NUL can't occur in a fence, so it separates the two halves
  // unambiguously. Written as an escape rather than typed literally — a raw
  // NUL byte in the source makes git treat this whole file as binary and
  // stop diffing it.
  const key = `${language}\u0000${source}`;
  // Keyed state rather than a bare string: react-markdown reuses this
  // component instance across content changes, so a plain `html` would keep
  // painting the *previous* fence's tokens — permanently in the case where
  // the new key is already cached and the effect below returns early.
  // Reading the cache during render also paints a revisited block colored on
  // the first frame, with no effect and no second render.
  const [done, setDone] = useState<{ key: string; html: string } | null>(null);
  const html = done?.key === key ? done.html : (COLORIZED.get(key) ?? null);

  useEffect(() => {
    if (COLORIZED.has(key)) return;
    let disposed = false;
    void (async () => {
      try {
        const pending = loadedMonaco();
        if (!pending) return;
        const monaco = await pending;
        const colored = await monaco.editor.colorize(source, language, { tabSize: 2 });
        if (COLORIZED.size >= COLORIZED_MAX) COLORIZED.clear();
        COLORIZED.set(key, colored);
        if (!disposed) setDone({ key, html: colored });
      } catch {
        // No grammar for this fence — plain text below is a fine fallback.
      }
    })();
    return () => {
      disposed = true;
    };
  }, [key, language, source]);

  if (html == null) return <code className={className}>{source}</code>;
  return <code className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * react-markdown routes *inline* `code` through this too, and prose has far
 * more inline spans than fences — so resolve the language first and only mount
 * the stateful highlighter for a fence that can actually be colored.
 */
export function MarkdownCode({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const language = monacoLanguageFor(className);
  const source = String(children ?? "").replace(/\n$/, "");
  if (!language) return <code className={className}>{source}</code>;
  return <FencedCode language={language} source={source} className={className} />;
}
