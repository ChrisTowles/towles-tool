import { useEffect, useState } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { monacoLanguageFor } from "@/lib/markdown-code";
import { loadedMonaco } from "@/lib/monaco";
import { cn } from "@/lib/utils";

/**
 * Markdown for content that is **not a file in a checkout** — today, an
 * agent's replies in a chat pane.
 *
 * Deliberately *not* the same renderer as the files pane's preview, which
 * resolves relative images and links against the file's directory, renders
 * GitHub alerts, assigns heading anchor ids, and sanitizes raw HTML off disk.
 * All of that is file-scoped by construction: it needs a `dir` and a `path`,
 * and agent output has neither. Forcing chat through it would mean inventing
 * a base path that doesn't exist.
 *
 * What the two genuinely share is the fence highlighter below — one Monaco
 * tokenizer and, importantly, **one cache**. That is why `MarkdownCode` lives
 * here and `file-preview.tsx` imports it, rather than each keeping a copy.
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

/**
 * An image the preview could not resolve — an unsupported scheme, a path
 * pointing outside the checkout, or plain browser dev where the asset protocol
 * isn't registered.
 *
 * Shown as its alt text rather than a broken-image box: the alt is what the
 * author wrote to describe the picture, so it is both the most informative
 * thing available and the accessible fallback the format already specifies.
 */

/**
 * Render `content` as GFM markdown.
 *
 * `prose` (tailwind-typography) supplies block spacing, list markers and table
 * borders; without it a GFM table renders as unstyled rows and reads worse
 * than the raw pipes it replaced.
 */
/** Module-level, not built inside `Markdown`: defining components during a
 * render remounts their whole subtree on every state change. Nothing here
 * closes over props, so unlike the files pane's `markdownComponents` factory
 * this can be a plain constant. */
const CHAT_COMPONENTS: Components = {
  code: MarkdownCode,
  // A wide table otherwise widens the pane and pushes the reply off screen;
  // scrolling belongs to the table, not the transcript.
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
};

const CHAT_REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm];

export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("prose prose-sm dark:prose-invert max-w-none", className)}>
      <ReactMarkdown remarkPlugins={CHAT_REMARK_PLUGINS} components={CHAT_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
