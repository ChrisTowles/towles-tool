const MAX_OFFERS = 3
const SHOWN_CHARS = 40
/** Offers a session may leave uncopied before it goes quiet. */
export const IGNORED_LIMIT = 3
/** How long a quiet session stays quiet before one probe offer, so a copy can still reset it. */
export const QUIET_MS = 30 * 60 * 1000
/** Apart enough that a clipboard manager records each write as its own entry. */
export const COPY_ALL_GAP_MS = 400

/** The command after a leading `! `, or `null` when `text` does not open with one. */
function bang(text: string): string | null {
  const command = text.trimStart().startsWith('! ') ? text.trimStart().slice(2).trim() : ''
  return command || null
}

/** The `! <command>`s the answer hands the user, in order, deduplicated, at most three. A
 * command is a line (indented, or inside a fence) that opens with `! `, or an inline code
 * span that does; a trailing `\` continues it onto the next line. Each keeps its `! `, so a
 * paste into the prompt runs it in bash mode. */
export function offers(answer: string): string[] {
  const found: string[] = []
  const lines = answer.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line.startsWith('```') || line.startsWith('~~~')) continue
    let command = bang(line)
    if (command) {
      while (command.endsWith('\\') && i + 1 < lines.length) command += `\n${lines[++i]!.trimEnd()}`
      found.push(command)
    } else {
      found.push(...line.split('`').filter((_, n) => n % 2 === 1).flatMap(span => bang(span) ?? []))
    }
  }
  const out: string[] = []
  for (const command of found) {
    const text = `! ${command.trimEnd()}`
    if (out.length < MAX_OFFERS && !out.includes(text)) out.push(text)
  }
  return out
}

/** The offer flattened to one band row. */
export const clipLine = (offer: string): string => offer.trim().replace(/\s+/g, ' ')

/** The same, cut short for the toast. */
export function clipShown(offer: string): string {
  const line = clipLine(offer)
  return line.length > SHOWN_CHARS ? `${line.slice(0, SHOWN_CHARS - 1)}…` : line
}

/** Offers this session left uncopied, and when the last one went up. */
export type Ignored = { offers: number; lastMs: number }

export function quiet(ignored: Ignored, nowMs: number): boolean {
  return ignored.offers >= IGNORED_LIMIT && nowMs - ignored.lastMs < QUIET_MS
}
