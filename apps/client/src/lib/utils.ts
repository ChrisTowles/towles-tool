import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** `index.css`'s type scale, so `text-mini` merges as a size, not a color. */
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["micro", "mini", "caption"] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
