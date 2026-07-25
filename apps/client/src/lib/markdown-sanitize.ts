/**
 * What raw HTML inside a previewed Markdown file is allowed to be.
 *
 * READMEs are full of HTML that Markdown syntax can't express — a centered
 * logo (`<p align="center"><img …></p>`), a collapsible section
 * (`<details><summary>`), a `<picture>` with a dark-mode `<source>`. Without
 * `rehype-raw` all of it silently disappears, which is why parts of a README
 * used to render as gaps.
 *
 * `rehype-raw` alone would be reckless: `tauri.conf.json` sets `csp: null`, so
 * a `<script>` in a Markdown file someone cloned would run in the app's
 * origin, with its IPC surface. The two ship together and always in this order
 * — raw parses the HTML, sanitize decides what survives.
 *
 * The base is `hast-util-sanitize`'s GitHub-derived default, which already
 * covers the common cases and, usefully, prefixes any `id` a document brings
 * with `user-content-` so raw HTML can't clobber the app's own element ids.
 * Only the gaps below are opened, each for a reason.
 */

import { defaultSchema } from "rehype-sanitize";
import { ALERT_ATTRIBUTE } from "@/lib/remark-alerts";

const base = defaultSchema;

export const previewSanitizeSchema = {
  ...base,
  tagNames: [
    ...(base.tagNames ?? []),
    // Screen recordings in a README are increasingly `<video>` rather than a
    // GIF — the file is a fraction of the size for the same clip.
    "video",
  ],
  attributes: {
    ...base.attributes,
    // Set by `remarkAlerts`; the preview's `blockquote` component reads it
    // back to pick the callout's color. Stripped here it would be as if the
    // plugin never ran — and silently, since a sanitized alert is still a
    // perfectly good blockquote.
    //
    // Listed under *both* spellings because which one is present depends on
    // what ran before this. `hast-util-sanitize` matches the literal key in
    // `node.properties`; `mdast-util-to-hast` copies `hProperties` through
    // verbatim as `data-alert`, but `rehype-raw` re-parses the whole tree
    // through parse5, which canonicalizes it to property-information's
    // `dataAlert`. Today raw always runs first, so `dataAlert` is the one that
    // matters — and a pipeline change that reorders them shouldn't silently
    // turn every callout back into a blockquote.
    blockquote: [
      ...(base.attributes?.blockquote ?? []),
      ALERT_ATTRIBUTE,
      ALERT_ATTRIBUTE.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()),
    ],
    // `srcSet` for `<picture>`'s dark-mode variants; `loading`/`decoding`
    // because a README's images are exactly the ones worth deferring.
    img: [...(base.attributes?.img ?? []), "srcSet", "sizes", "loading", "decoding"],
    source: [...(base.attributes?.source ?? []), "src", "type", "sizes"],
    video: ["src", "poster", "controls", "loop", "muted", "autoPlay", "playsInline"],
  },
  protocols: {
    ...base.protocols,
    // The default allows only http/https here, which would strip the `src` off
    // every inline `data:` image. `resolveMarkdownSrc` is the real gate on
    // what an `src` may be — this list only has to not contradict it.
    src: [...(base.protocols?.src ?? []), "data"],
  },
  // Unlisted elements are *unwrapped*, not removed, so their text content
  // survives — harmless for a `<marquee>`, but it would paste the contents of
  // a `<style>` block into the page as prose.
  strip: [...(base.strip ?? []), "style"],
};
