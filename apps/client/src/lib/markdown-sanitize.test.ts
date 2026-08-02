/** These run the *real* plugin pipeline rather than testing the schema object's
 * shape: the schema matches property keys literally, so allowing `dataAlert`
 * instead of `data-alert` strips the attribute and every callout silently
 * degrades to an ordinary blockquote — nothing throws, nothing logs. */

import { describe, expect, it } from "vitest";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import type { Element, Root } from "hast";
import { previewSanitizeSchema } from "@/lib/markdown-sanitize";
import { ALERT_ATTRIBUTE, remarkAlerts } from "@/lib/remark-alerts";

/** The same plugin set `FilePreview` renders with, stopping at hast. */
const pipeline = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkAlerts)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, previewSanitizeSchema);

function process(markdown: string): Root {
  return pipeline.runSync(pipeline.parse(markdown)) as Root;
}

/** Every element in a tree, depth-first. */
function elements(node: Root | Element): Element[] {
  const out: Element[] = [];
  for (const child of node.children) {
    if (child.type === "element") out.push(child, ...elements(child));
  }
  return out;
}

function firstTag(tree: Root, tagName: string): Element | undefined {
  return elements(tree).find((el) => el.tagName === tagName);
}

describe("the preview pipeline", () => {
  // `rehype-raw` re-parses through parse5, which canonicalizes `data-alert`
  // to `dataAlert` before sanitize sees it — so the schema has to allow the
  // spelling that survives that round trip, not the one the plugin wrote.
  // Asserted on both keys because the component reads whichever arrives.
  it("keeps the alert marker on the blockquote", () => {
    const tree = process("> [!WARNING]\n> This is a personal playground.");
    const properties = firstTag(tree, "blockquote")?.properties ?? {};
    expect(properties[ALERT_ATTRIBUTE] ?? properties.dataAlert).toBe("warning");
  });

  it("leaves an ordinary blockquote unmarked", () => {
    const properties = firstTag(process("> Just a quotation."), "blockquote")?.properties ?? {};
    expect(properties[ALERT_ATTRIBUTE] ?? properties.dataAlert).toBeUndefined();
  });

  it("renders raw HTML a README embeds", () => {
    const tree = process('<p align="center"><img src="docs/logo.png" alt="logo"></p>');
    const img = firstTag(tree, "img");
    expect(img?.properties.src).toBe("docs/logo.png");
    expect(firstTag(tree, "p")?.properties.align).toBe("center");
  });

  it("keeps details/summary and picture/source", () => {
    const tree = process(
      "<details><summary>More</summary>body</details>\n\n" +
        '<picture><source srcset="dark.png" media="(prefers-color-scheme: dark)">' +
        '<img src="light.png" alt="d"></picture>',
    );
    const tags = elements(tree).map((el) => el.tagName);
    expect(tags).toEqual(
      expect.arrayContaining(["details", "summary", "picture", "source", "img"]),
    );
    expect(firstTag(tree, "source")?.properties.srcSet).toBe("dark.png");
  });

  // The reason `rehype-sanitize` is not optional: `csp: null` means a script
  // that survived here would run in the app's origin, with its IPC surface.
  it("strips script and its contents", () => {
    const tree = process('text\n\n<script>window.alert("x")</script>');
    expect(elements(tree).map((el) => el.tagName)).not.toContain("script");
    expect(JSON.stringify(tree)).not.toContain("window.alert");
  });

  // An unlisted element is *unwrapped*, keeping its text — which for a style
  // block would paste CSS into the page as prose.
  it("strips style blocks rather than unwrapping them", () => {
    const tree = process("text\n\n<style>body { color: red }</style>");
    expect(JSON.stringify(tree)).not.toContain("color: red");
  });

  it("drops an event handler attribute", () => {
    const tree = process('<img src="a.png" onerror="alert(1)" alt="a">');
    expect(firstTag(tree, "img")?.properties.onError).toBeUndefined();
  });

  it("keeps a relative image src for the component to resolve", () => {
    const tree = process("![demo](docs/images/demo.gif)");
    expect(firstTag(tree, "img")?.properties.src).toBe("docs/images/demo.gif");
  });

  it("keeps an inline data: image, which the default schema would strip", () => {
    const tree = process("![dot](data:image/gif;base64,R0lGODlhAQABAAAAACw=)");
    expect(firstTag(tree, "img")?.properties.src).toBe(
      "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
    );
  });

  it("keeps the language class a fence needs for highlighting", () => {
    const tree = process("```rust\nfn main() {}\n```");
    expect(firstTag(tree, "code")?.properties.className).toEqual(["language-rust"]);
  });
});
