import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { MarkdownCode } from "@/components/markdown";
import { previewSanitizeSchema } from "@/lib/markdown-sanitize";
import { remarkAlerts } from "@/lib/remark-alerts";
import type { PreviewDoc } from "@/lib/preview-artifact";

/** The rendered body of a file in the Preview pane, by the `kind` Rust derives
 * from the extension. A previewed file has no checkout to resolve paths against. */

const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm, remarkAlerts];
/** `previewSanitizeSchema` is what stops a `<script>` in a Markdown file
 * running in the app's origin once `rehypeRaw` has parsed it. */
const REHYPE_PLUGINS: Options["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, previewSanitizeSchema],
];

/** No `img` override: a previewed file has no checkout to resolve a relative
 * src against, so a remote or `data:` one is all that can work. */
const COMPONENTS: Components = {
  code: MarkdownCode,
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
};

export function PreviewDocView({ doc, title }: { doc: PreviewDoc; title: string }) {
  if (doc.kind === "html") {
    // Sandboxed with scripts but no `allow-same-origin`: the page gets charts,
    // toggles and tabs on a unique opaque origin, so it can't reach the app's
    // storage or back through the frame.
    return (
      <iframe
        srcDoc={doc.content}
        sandbox="allow-scripts"
        title={title}
        className="absolute inset-0 h-full w-full border-0 bg-white"
      />
    );
  }
  if (doc.kind === "markdown") {
    return (
      <div className="absolute inset-0 overflow-y-auto px-4 py-3">
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={COMPONENTS}
          >
            {doc.content}
          </ReactMarkdown>
        </div>
      </div>
    );
  }
  return (
    <pre className="absolute inset-0 overflow-auto px-3 py-2 font-mono text-[11px] whitespace-pre">
      {doc.content}
    </pre>
  );
}
