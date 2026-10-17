import type { ClipOffer } from '../types'

const ANSWER_CHARS = 4000
const SHOWN_CHARS = 40
/** Apart enough that a clipboard manager records each write as its own entry. */
export const COPY_ALL_GAP_MS = 400

/** The tail of the agent's last message, where what it just printed sits. */
export const clipAnswer = (answer: string): string => answer.slice(-ANSWER_CHARS)

/** The text a copy puts on the clipboard, flattened to one band row. */
export const clipLine = (offer: ClipOffer): string => offer.text.trim().replace(/\s+/g, ' ')

/** The same, cut short for the toast. */
export function clipShown(offer: ClipOffer): string {
  const line = clipLine(offer)
  return line.length > SHOWN_CHARS ? `${line.slice(0, SHOWN_CHARS - 1)}…` : line
}

/** The offers as `clip_suggest` sent them, dropping anything malformed. */
export function offersFrom(raw: unknown): ClipOffer[] {
  const items = (raw as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return []
  return items
    .filter(
      (i): i is ClipOffer =>
        !!i && typeof i.label === 'string' && typeof i.text === 'string' && i.text.trim() !== '',
    )
    .slice(0, 3)
}
