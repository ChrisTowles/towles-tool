/**
 * Get the Monday of the week for a given date
 */
export function getMondayOfWeek(date: Date): Date {
  const newDate = new Date(date)
  const day = newDate.getDay()
  const diff = newDate.getDate() - day + (day === 0 ? -6 : 1)
  newDate.setDate(diff)
  newDate.setHours(0, 0, 0, 0)
  return newDate
}

/**
 * Format date as YYYY-MM-DD
 */
export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]
}

/**
 * Generate journal filename based on Monday of the current week
 * Format: YYYY-MM-DD-week.md (always uses Monday's date)
 */
export function generateJournalFilename(date: Date = new Date()): string {
  const monday = getMondayOfWeek(new Date(date))
  return `${formatDate(monday)}-week.md`
}
