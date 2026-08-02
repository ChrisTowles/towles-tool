import { useEffect, useMemo, useRef, useState } from "react";
import type { Element, ElementContent } from "hast";
import {
  FileQuestion,
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
import { MarkdownCode } from "@/components/markdown";
import { ImageLightbox, type LightboxImage } from "@/components/image-lightbox";
import { ideReadFile, ideUnwatchFiles, ideWatchFiles, onFileChangedOnDisk } from "@/lib/ide";
import { NotInTauri } from "@/lib/errors";
import { allowAssetDir, assetUrl, resolveMarkdownSrc } from "@/lib/markdown-assets";
import { classifyMarkdownLink, headingSlug } from "@/lib/markdown-links";
import { previewSanitizeSchema } from "@/lib/markdown-sanitize";
import { opensInEditor, type PreviewKind } from "@/lib/preview-kind";
import { ALERT_ATTRIBUTE, type AlertKind } from "@/lib/remark-alerts";
import { remarkAlerts } from "@/lib/remark-alerts";
import { openExternalUrl } from "@/lib/open-url";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

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

/** An image from Markdown syntax or raw HTML — both land here, which is what
 * keeps `<p align="center"><img>` resolving the same way `![](…)` does. */
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
        // A linked image belongs to its link, as on GitHub — let it bubble.
        if (e.currentTarget.closest("a")) return;
        onZoom({ id: url, name, previewUrl: url });
        uiAction("preview.zoom_image", "agentboard");
      }}
    />
  );
}

/** A link in the preview. Every kind needs handling — `lib/markdown-links.ts`
 * says why the browser's own behavior is wrong for all three. */
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
          // Scoped to this preview's container: heading ids aren't app-unique.
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

/** Headings, carrying the anchor id their document's links expect. Ids are not
 * deduplicated, so a repeated heading's second copy is unreachable by link. */
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

/** A blockquote, or — when `remarkAlerts` marked it — a GitHub-style callout.
 * Read as an attribute, so an ordinary blockquote takes the path it always did. */
const MarkdownBlockquote: Components["blockquote"] = ({ children, ...props }) => {
  // `data-alert` is ours; react-markdown's props are typed from the DOM.
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

/** A file the pane renders directly instead of opening in the editor. The bytes
 * come from the same `ttasset` protocol the Markdown preview's images use. */
function MediaFile({
  dir,
  path,
  kind,
  onZoom,
}: {
  dir: string;
  path: string;
  kind: "image" | "video" | "binary";
  onZoom: (image: LightboxImage) => void;
}) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const url = kind === "binary" ? null : assetUrl(dir, path);
  if (url === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
        <FileQuestion className="size-8 text-muted-foreground/60" />
        <p className="text-sm text-foreground">{name}</p>
        <p className="text-xs text-muted-foreground">
          {kind === "binary"
            ? "This file can't be displayed here."
            : "Not available in browser dev."}
        </p>
      </div>
    );
  }
  if (kind === "video") {
    return (
      <div className="flex h-full items-center justify-center overflow-auto p-3">
        {/* No captions track to offer — this is whatever file the repo holds. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video src={url} controls className="max-h-full max-w-full rounded border border-border" />
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-3">
      <img
        src={url}
        alt={name}
        // A checkerboard, so a transparent PNG reads as transparent.
        style={{
          backgroundImage:
            "repeating-conic-gradient(oklch(0.5 0 0 / 0.18) 0% 25%, transparent 0% 50%)",
          backgroundSize: "16px 16px",
        }}
        className="max-h-full max-w-full cursor-zoom-in rounded border border-border object-contain"
        onClick={() => {
          onZoom({ id: url, name, previewUrl: url });
          uiAction("preview.zoom_image", "agentboard", "file");
        }}
      />
    </div>
  );
}

/** A module-level factory, not an object literal built inside `FilePreview`:
 * defining components during a render remounts their whole subtree. */
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
    // Scrolling belongs to the table, not the document.
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

// Fixed for the module's lifetime — a fresh array reprocesses the document per
// render. `rehypeRaw` must precede `rehypeSanitize`, which decides what runs.
const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm, remarkAlerts];
const REHYPE_PLUGINS: Options["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, previewSanitizeSchema],
];

/** Read-only render of a Markdown or HTML file. HTML gets a script-less
 * sandboxed iframe; without `onOpenPath`, repo links render as plain text. */
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
  // Whether the checkout is registered with the asset protocol. Media only.
  const [mediaReady, setMediaReady] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Initial read plus re-reads on disk change. A refresh keeps the old content
  // up until the new read lands, so it never flashes "Loading…".
  useEffect(() => {
    let disposed = false;
    setContent(null);
    setError(null);
    setZoomed(null);
    setMediaReady(false);
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
    // Media renders straight from the asset protocol, but must *wait* on the
    // registration: an `<img>` that fires first takes a 403 it never retries.
    if (!opensInEditor(kind)) {
      void allowAssetDir(dir).then(() => {
        if (!disposed) setMediaReady(true);
      });
      return () => {
        disposed = true;
      };
    }
    if (kind === "markdown") {
      // Ordered, not raced: the protocol refuses an unregistered folder, and the
      // `<img>` tags start fetching the moment the content lands.
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

  // A fresh object here remounts the whole document on every state change.
  const components = useMemo(
    () => markdownComponents({ dir, path, containerRef, onOpenPath, onZoom: setZoomed }),
    [dir, path, onOpenPath],
  );

  // Before the loading/error gates, which are about text this file lacks.
  if (kind === "image" || kind === "video" || kind === "binary") {
    if (!mediaReady) return <p className="p-3 text-sm text-muted-foreground">Loading…</p>;
    return (
      <>
        <MediaFile dir={dir} path={path} kind={kind} onZoom={setZoomed} />
        <ImageLightbox
          images={zoomed ? [zoomed] : []}
          openId={zoomed?.id ?? null}
          onOpenChange={(id) => {
            if (id === null) setZoomed(null);
          }}
        />
      </>
    );
  }
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
