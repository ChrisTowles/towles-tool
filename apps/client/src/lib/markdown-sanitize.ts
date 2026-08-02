/** Always ships with `rehype-raw`, reckless alone: `csp: null` means a
 * `<script>` in a cloned README would run in the app's origin. */

import { defaultSchema } from "rehype-sanitize";
import { ALERT_ATTRIBUTE } from "@/lib/remark-alerts";

const base = defaultSchema;

export const previewSanitizeSchema = {
  ...base,
  tagNames: [
    ...(base.tagNames ?? []),
    "video",
  ],
  attributes: {
    ...base.attributes,
    // Both spellings — parse5 (via rehype-raw) canonicalizes it to `dataAlert`.
    blockquote: [
      ...(base.attributes?.blockquote ?? []),
      ALERT_ATTRIBUTE,
      ALERT_ATTRIBUTE.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()),
    ],
    img: [...(base.attributes?.img ?? []), "srcSet", "sizes", "loading", "decoding"],
    source: [...(base.attributes?.source ?? []), "src", "type", "sizes"],
    video: ["src", "poster", "controls", "loop", "muted", "autoPlay", "playsInline"],
  },
  protocols: {
    ...base.protocols,
    src: [...(base.protocols?.src ?? []), "data"],
  },
  strip: [...(base.strip ?? []), "style"],
};
