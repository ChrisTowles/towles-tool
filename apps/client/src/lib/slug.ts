/**
 * Mirrors `tt-git`'s branch-name slugging. Shared, not re-derived: it also
 * mints calendar store-lane ids, which key `events` rows permanently.
 */
export function slugify(text: string): string {
  let slug = text.toLowerCase().trim().replaceAll(" ", "-");
  slug = slug.replace(/[^0-9a-z_-]/g, "-");
  slug = slug.replace(/-+/g, "-");
  slug = slug.replace(/-+$/, "");
  return slug;
}
