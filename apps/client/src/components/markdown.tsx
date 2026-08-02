import { useEffect, useState } from "react";
import { monacoLanguageFor } from "@/lib/markdown-code";
import { loadedMonaco } from "@/lib/monaco";

const COLORIZED = new Map<string, string>();
const COLORIZED_MAX = 200;

/** Never *starts* the Monaco load; plain text is the fallback until something
 * else boots it. `dangerouslySetInnerHTML` is safe only because the colorizer
 * HTML-escapes its source. */
function FencedCode({
  language,
  source,
  className,
}: {
  language: string;
  source: string;
  className?: string;
}) {
  // Escaped rather than a literal NUL, which would make git treat this file as binary.
  const key = `${language}\u0000${source}`;
  // Keyed, because react-markdown reuses this instance across content changes
  // and a bare `html` would keep painting the previous fence's tokens.
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

/** react-markdown routes inline `code` here too, so resolve the language first
 * and only mount the stateful highlighter for a colorable fence. */
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
