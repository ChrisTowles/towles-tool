import type { ClipOffer } from '../types'

const ANSWER_CHARS = 4000
const LABEL_CHARS = 28
/** Apart enough that a clipboard manager records each write as its own entry. */
export const COPY_ALL_GAP_MS = 400

/** The tail of the agent's last message, where what it just printed sits. */
export const clipAnswer = (answer: string): string => answer.slice(-ANSWER_CHARS)

export function clipLabel(offer: ClipOffer): string {
  const label = offer.label.trim() || offer.text.trim()
  return label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label
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
