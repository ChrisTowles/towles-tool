import type { InboxNote } from '../types'

/** Delivered ids kept, so a note re-offered after a lapsed lease is not handed over twice. */
export const SEEN_KEEP = 50

/** How a note reads to the model mid-turn: framed, since it arrives between tool calls. */
export const MID_TURN_LEAD = 'A note from the user, sent from the tt app while you work:'

function withImages(body: string, images: readonly string[]): string {
  const paths = images.map(path => `Attached image, read it first: ${path}`)
  return [body, ...paths].filter(Boolean).join('\n')
}

/** The notes as the user's own prompt, for a session at rest. */
export function promptText(notes: readonly InboxNote[]): string {
  return notes.map(n => withImages(n.body, n.images)).join('\n\n')
}

export function midTurnText(notes: readonly InboxNote[]): string {
  return `${MID_TURN_LEAD}\n\n${promptText(notes)}`
}

export function unseen(notes: readonly InboxNote[], seen: readonly number[]): InboxNote[] {
  return notes.filter(n => !seen.includes(n.id))
}

export function remember(seen: readonly number[], ids: readonly number[]): number[] {
  return [...seen, ...ids].slice(-SEEN_KEEP)
}

/** A note appended during a turn's step is read by the step after it, so one appended
 * during the turn's last step was never read; it goes again as a prompt. */
export type Appended = { ids: number[]; text: string; step: number }

export function stranded<T extends Appended>(appended: readonly T[], lastStep: number): T[] {
  return appended.filter(a => a.step >= lastStep)
}
