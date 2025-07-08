import { describe, expect, it } from 'vitest'
import { formatDate, generateJournalFilename, getMondayOfWeek } from '../src/utils/date'

describe('date utilities', () => {
  it('should get Monday of the week correctly', () => {
    // Test with a Wednesday (July 9, 2025)
    const wednesday = new Date(2025, 6, 9) // July 9, 2025
    const monday = getMondayOfWeek(wednesday)
    expect(formatDate(monday)).toBe('2025-07-07')

    // Test with a Friday (July 11, 2025)
    const friday = new Date(2025, 6, 11) // July 11, 2025
    const mondayFromFriday = getMondayOfWeek(friday)
    expect(formatDate(mondayFromFriday)).toBe('2025-07-07')

    // Test with a Sunday (July 13, 2025) - should return Monday of previous week
    const sunday = new Date(2025, 6, 13) // July 13, 2025
    const mondayFromSunday = getMondayOfWeek(sunday)
    expect(formatDate(mondayFromSunday)).toBe('2025-07-07')

    // Test with a Monday (July 7, 2025)
    const actualMonday = new Date(2025, 6, 7) // July 7, 2025
    const mondayFromMonday = getMondayOfWeek(actualMonday)
    expect(formatDate(mondayFromMonday)).toBe('2025-07-07')
  })

  it('should generate correct journal filename', () => {
    // Test with different days in the same week
    const wednesday = new Date(2025, 6, 9) // July 9, 2025
    const filename = generateJournalFilename(wednesday)
    expect(filename).toBe('2025-07-07-week.md')

    const friday = new Date(2025, 6, 11) // July 11, 2025
    const filenameFromFriday = generateJournalFilename(friday)
    expect(filenameFromFriday).toBe('2025-07-07-week.md')
  })

  it('should format date correctly', () => {
    const date = new Date('2025-07-07')
    expect(formatDate(date)).toBe('2025-07-07')
  })
})
