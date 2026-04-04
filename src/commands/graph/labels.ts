import type { JournalEntry } from "./types.js";

/**
 * Extract a meaningful label from session entries.
 */
export function extractSessionLabel(entries: JournalEntry[], sessionId: string): string {
  let firstUserText: string | undefined;
  let firstAssistantText: string | undefined;
  let gitBranch: string | undefined;
  let slug: string | undefined;

  for (const entry of entries) {
    // Extract metadata from any entry
    if (!gitBranch && entry.gitBranch) {
      gitBranch = entry.gitBranch;
    }
    if (!slug && entry.slug) {
      slug = entry.slug;
    }

    if (!entry.message) continue;

    // Look for first user message with actual text (not UUID reference)
    if (!firstUserText && entry.type === "user" && entry.message.role === "user") {
      const content = entry.message.content;
      if (typeof content === "string") {
        // Check if it's a UUID (skip those) or actual text
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          content,
        );
        if (!isUuid && content.length > 0) {
          firstUserText = content;
        }
      } else if (Array.isArray(content)) {
        // Look for text blocks in array content
        for (const block of content) {
          if (block.type === "text" && block.text && block.text.length > 0) {
            firstUserText = block.text;
            break;
          }
        }
      }
    }

    // Look for first assistant text response
    if (!firstAssistantText && entry.type === "assistant" && entry.message.role === "assistant") {
      const content = entry.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text && block.text.length > 0) {
            firstAssistantText = block.text;
            break;
          }
        }
      }
    }

    // Stop early if we have user text
    if (firstUserText) break;
  }

  // Priority: user text > assistant text > git branch > slug > short ID
  let label = firstUserText || firstAssistantText || gitBranch || slug || sessionId.slice(0, 8);

  // Clean up the label
  label = label
    .replace(/^\/\S+\s*/, "") // Remove /command prefixes
    .replace(/<[^>]+>[^<]*<\/[^>]+>/g, "") // Remove XML-style tags with content
    .replace(/<[^>]+>/g, "") // Remove remaining XML tags
    .replace(/^\s*Caveat:.*$/m, "") // Remove caveat lines
    .replace(/\n.*/g, "") // Take only first line
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F]+/g, " ") // Replace control characters with space
    .trim();

  // If still empty or too short, use fallback
  if (label.length < 3) {
    label = slug || sessionId.slice(0, 8);
  }

  // Truncate very long labels (will be smart-truncated in UI based on box size)
  if (label.length > 80) {
    label = label.slice(0, 77) + "...";
  }

  return label;
}
