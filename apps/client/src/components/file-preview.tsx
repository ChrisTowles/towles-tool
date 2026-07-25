import { useEffect, useMemo, useRef, useState } from "react";
import type { Element, ElementContent } from "hast";
import {
  Info,
  Lightbulb,
  MessageSquareWarning,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { ImageLightbox, type LightboxImage } from "@/components/image-lightbox";
import { ideReadFile, ideUnwatchFiles, ideWatchFiles, onFileChangedOnDisk } from "@/lib/ide";
import { NotInTauri } from "@/lib/errors";
import { monacoLanguageFor } from "@/lib/markdown-code";
import { allowAssetDir, assetUrl, resolveMarkdownSrc } from "@/lib/markdown-assets";
import { classifyMarkdownLink, headingSlug } from "@/lib/markdown-links";
import { previewSanitizeSchema } from "@/lib/markdown-sanitize";
import { ALERT_ATTRIBUTE, type AlertKind } from "@/lib/remark-alerts";
import { remarkAlerts } from "@/lib/remark-alerts";
import { loadedMonaco } from "@/lib/monaco";
import { openExternalUrl } from "@/lib/open-url";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

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
function MarkdownCode({ className, children }: { className?: string; children?: React.ReactNode }) {
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
function UnresolvedImage({ alt, src }: { alt?: string; src?: string }) {
  return (
    <span
      title={src ? `can't render ${src}` : "image has no source"}
      className="text-muted-foreground text-xs italic"
    >
      {alt?.trim() ? alt : "image"}
    </span>
  );
}

/**
 * An image in the preview, from either Markdown syntax or raw HTML — both
 * arrive here, which is what keeps `<p align="center"><img>` resolving the
 * same way `![](…)` does.
 *
 * Repo-relative sources become `ttasset` URLs (see `lib/markdown-assets.ts`);
 * remote ones are used as written. Lazy and async-decoded because a README's
 * images are mostly below the fold and some of them are multi-megabyte
 * recordings.
 */
function MarkdownImage({
  dir,
  mdPath,
  src,
  alt,
  title,
  onZoom,
}: {
  dir: string;
  mdPath: string;
  src?: string;
  alt?: string;
  title?: string;
  onZoom: (image: LightboxImage) => void;
}) {
  const target = resolveMarkdownSrc(mdPath, src ?? "");
  const url =
    target.kind === "external"
      ? target.url
      : target.kind === "repo"
        ? assetUrl(dir, target.path)
        : null;
  if (url === null) return <UnresolvedImage alt={alt} src={src} />;
  // The lightbox caption: what the author called it, else where it came from.
  const name = alt?.trim() || (target.kind === "repo" ? target.path : url);
  return (
    <img
      src={url}
      alt={alt ?? ""}
      title={title}
      loading="lazy"
      decoding="async"
      className="max-w-full cursor-zoom-in rounded border border-border"
      onClick={(e) => {
        // A linked image (the badge-linking-to-CI shape) belongs to its link,
        // the way it does on GitHub — let the click bubble to the anchor
        // instead of zooming. `closest` answers this at click time, which is
        // the only point where the surrounding markup is known.
        if (e.currentTarget.closest("a")) return;
        onZoom({ id: url, name, previewUrl: url });
        uiAction("preview.zoom_image", "agentboard");
      }}
    />
  );
}

/**
 * A link in the preview. Every kind needs handling — see
 * `lib/markdown-links.ts` for why the browser's own behavior is wrong for all
 * three (an external href navigates the entire app away from itself).
 */
function MarkdownAnchor({
  mdPath,
  href,
  children,
  containerRef,
  onOpenPath,
}: {
  mdPath: string;
  href?: string;
  children?: React.ReactNode;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onOpenPath?: (path: string) => void;
}) {
  const link = classifyMarkdownLink(mdPath, href ?? "");
  const dead = link.kind === "invalid" || (link.kind === "repo" && !onOpenPath);
  if (dead) return <span className="text-muted-foreground">{children}</span>;
  return (
    <a
      href={href}
      className="cursor-pointer"
      onClick={(e) => {
        e.preventDefault();
        if (link.kind === "external") {
          void openExternalUrl(link.url);
          uiAction("preview.open_link", "agentboard", "external");
        } else if (link.kind === "repo") {
          onOpenPath?.(link.path);
          uiAction("preview.open_link", "agentboard", "repo");
        } else if (link.kind === "anchor") {
          // Scoped to this preview's own container: heading ids are not
          // unique across the app, and `document.getElementById` would happily
          // scroll some other pane.
          containerRef.current
            ?.querySelector(`#${CSS.escape(link.hash)}`)
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
          uiAction("preview.open_link", "agentboard", "anchor");
        }
      }}
    >
      {children}
    </a>
  );
}

/** Flatten a hast element's text — a heading's own words, for its anchor id. */
function hastText(node: Element | undefined): string {
  if (!node) return "";
  let out = "";
  for (const child of node.children as ElementContent[]) {
    if (child.type === "text") out += child.value;
    else if (child.type === "element") out += hastText(child);
  }
  return out;
}

/**
 * Headings, carrying the anchor id their own document's links expect.
 *
 * Ids are not deduplicated: GitHub appends `-1` to a repeat, and matching that
 * would mean threading a counter through a per-heading component. Two
 * identical headings in one file means the second is unreachable by link,
 * which is a rare and visible-on-use limitation rather than a silent wrong
 * answer.
 */
function headingComponent(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as const;
  return function Heading({ node, children }: { node?: Element; children?: React.ReactNode }) {
    return (
      <Tag id={headingSlug(hastText(node))} className="scroll-mt-4">
        {children}
      </Tag>
    );
  };
}

/** Callout styling per alert kind — see `lib/remark-alerts.ts`. */
const ALERT_STYLES: Record<AlertKind, { label: string; accent: string; Icon: LucideIcon }> = {
  note: { label: "Note", accent: "border-l-sky-500 text-sky-600 dark:text-sky-400", Icon: Info },
  tip: {
    label: "Tip",
    accent: "border-l-emerald-500 text-emerald-600 dark:text-emerald-400",
    Icon: Lightbulb,
  },
  important: {
    label: "Important",
    accent: "border-l-violet-500 text-violet-600 dark:text-violet-400",
    Icon: MessageSquareWarning,
  },
  warning: {
    label: "Warning",
    accent: "border-l-amber-500 text-amber-600 dark:text-amber-400",
    Icon: TriangleAlert,
  },
  caution: {
    label: "Caution",
    accent: "border-l-red-500 text-red-600 dark:text-red-400",
    Icon: OctagonAlert,
  },
};

/**
 * A blockquote, or — when `remarkAlerts` marked it — a GitHub-style callout
 * with the kind's icon and label above the body.
 *
 * The attribute is read rather than a separate node type so an ordinary
 * blockquote keeps taking exactly the same path it always did.
 */
const MarkdownBlockquote: Components["blockquote"] = ({ children, ...props }) => {
  // `data-alert` is ours, set on the hast node by `remarkAlerts` and passed
  // through by rehype — react-markdown's element props are typed from the DOM,
  // which knows nothing about it.
  const kind = (props as Record<string, unknown>)[ALERT_ATTRIBUTE];
  const style = typeof kind === "string" ? ALERT_STYLES[kind as AlertKind] : undefined;
  if (!style) return <blockquote>{children}</blockquote>;
  return (
    <blockquote className={cn("not-italic", style.accent)}>
      <span className={cn("mb-1 flex items-center gap-1.5 text-sm font-medium", style.accent)}>
        <style.Icon className="size-4 shrink-0" />
        {style.label}
      </span>
      <div className="text-foreground">{children}</div>
    </blockquote>
  );
};

/** Extensions the file viewer knows how to render a live preview for. */
export type PreviewKind = "markdown" | "html";

export function previewKindFor(path: string): PreviewKind | null {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  return null;
}

/**
 * Plugins, fixed for the lifetime of the module — rebuilding these arrays per
 * render makes react-markdown reprocess the whole document on every state
 * change, including opening the lightbox.
 *
 * `rehypeRaw` must precede `rehypeSanitize`, and neither is optional: raw
 * parses the HTML a README embeds, sanitize decides what survives it (see
 * `lib/markdown-sanitize.ts` — `csp: null` means unsanitized raw HTML would
 * run script in the app's origin).
 */
/**
 * The element overrides for one document.
 *
 * A module-level factory rather than an object literal built inside
 * `FilePreview`: half of these close over which file the relative paths in it
 * are relative to, so they can't be plain constants — but defining components
 * during a render is what makes React remount their whole subtree on every
 * state change, and the call site memoizes this on exactly the values it
 * closes over.
 */
function markdownComponents({
  dir,
  path,
  containerRef,
  onOpenPath,
  onZoom,
}: {
  dir: string;
  path: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onOpenPath?: (path: string) => void;
  onZoom: (image: LightboxImage) => void;
}): Components {
  return {
    code: MarkdownCode,
    blockquote: MarkdownBlockquote,
    img: ({ src, alt, title }) => (
      <MarkdownImage
        dir={dir}
        mdPath={path}
        src={typeof src === "string" ? src : undefined}
        alt={alt}
        title={title}
        onZoom={onZoom}
      />
    ),
    a: ({ href, children }) => (
      <MarkdownAnchor mdPath={path} href={href} containerRef={containerRef} onOpenPath={onOpenPath}>
        {children}
      </MarkdownAnchor>
    ),
    // A wide table otherwise widens the whole pane and pushes the prose off
    // screen; scrolling belongs to the table, not the document.
    table: ({ children }) => (
      <div className="max-w-full overflow-x-auto">
        <table>{children}</table>
      </div>
    ),
    h1: headingComponent(1),
    h2: headingComponent(2),
    h3: headingComponent(3),
    h4: headingComponent(4),
    h5: headingComponent(5),
    h6: headingComponent(6),
  };
}

const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm, remarkAlerts];
const REHYPE_PLUGINS: Options["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, previewSanitizeSchema],
];

/**
 * Read-only render of a Markdown or HTML file's current-on-disk content —
 * the split pane's right side. HTML renders in a script-less sandboxed
 * iframe so a previewed file can never run script in the app's origin.
 *
 * Markdown gets the fuller treatment: images and GIFs resolve against the
 * checkout, links do what their kind implies rather than navigating the app
 * away, GitHub alerts render as callouts, and headings carry the anchor ids
 * their document's own links expect. `onOpenPath` is how a relative link to
 * another file gets there — without it such links render as plain text, since
 * a link that silently does nothing is worse than one that doesn't look like
 * a link.
 */
export function FilePreview({
  dir,
  path,
  kind,
  onOpenPath,
}: {
  dir: string;
  path: string;
  kind: PreviewKind;
  onOpenPath?: (path: string) => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<LightboxImage | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // One effect: initial read, plus re-reads when the file changes on disk
  // (an agent edit). The preview registers its own watch — refcounted in
  // Rust, so sharing a file with the sibling CodeViewer costs nothing, and
  // the preview keeps refreshing even without one. On a refresh the old
  // content stays up until the new read lands, so it never flashes
  // "Loading…"; only the initial read surfaces an error state.
  useEffect(() => {
    let disposed = false;
    setContent(null);
    setError(null);
    setZoomed(null);
    const read = (initial: boolean) => {
      void ideReadFile(dir, path).then((r) => {
        if (disposed) return;
        r.match({
          ok: (file) => setContent(file.content),
          err: (e) => {
            if (initial) setError(NotInTauri.is(e) ? "not available in browser dev" : e.message);
          },
        });
      });
    };
    if (kind === "markdown") {
      // Ordered, not raced: the asset protocol refuses a folder it hasn't been
      // told about, and the `<img>` tags this document renders start fetching
      // the moment the content lands. Its failure needs no handling — in
      // browser dev the read below fails the same way, and in the shell a
      // refused folder shows up as unresolved images.
      void allowAssetDir(dir).then(() => {
        if (!disposed) read(true);
      });
    } else {
      read(true);
    }
    void ideWatchFiles(dir, [path]);
    const off = onFileChangedOnDisk(dir, path, () => read(false));
    return () => {
      disposed = true;
      off();
      void ideUnwatchFiles(dir, [path]);
    };
  }, [dir, path, kind]);

  // Memoized on exactly what the overrides close over — a fresh object here
  // remounts the whole rendered document on every state change, the lightbox
  // opening included.
  const components = useMemo(
    () => markdownComponents({ dir, path, containerRef, onOpenPath, onZoom: setZoomed }),
    [dir, path, onOpenPath],
  );

  if (error) {
    return <p className="p-3 text-sm text-muted-foreground">{error}</p>;
  }
  if (content == null) {
    return <p className="p-3 text-sm text-muted-foreground">Loading…</p>;
  }
  if (kind === "html") {
    return (
      <iframe
        title={path}
        srcDoc={content}
        sandbox=""
        className="h-full w-full border-0 bg-white"
      />
    );
  }
  return (
    <div ref={containerRef} className="h-full min-w-0 flex-1 overflow-y-auto px-4 py-3">
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={components}
        >
          {content}
        </ReactMarkdown>
      </div>
      <ImageLightbox
        images={zoomed ? [zoomed] : []}
        openId={zoomed?.id ?? null}
        onOpenChange={(id) => {
          if (id === null) setZoomed(null);
        }}
      />
    </div>
  );
}
