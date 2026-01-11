/**
 * Journal types and constants
 */

export const JOURNAL_TYPES = {
  DAILY_NOTES: 'daily-notes',
  MEETING: 'meeting',
  NOTE: 'note',
} as const

export type JournalType = typeof JOURNAL_TYPES[keyof typeof JOURNAL_TYPES]

export interface JournalArgs {
  title?: string
  journalType: JournalType
}
