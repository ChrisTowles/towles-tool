/**
 * Tests for observe graph command --days filtering
 */
import { describe, it, expect } from 'bun:test'

/**
 * Test the days filtering logic used by findRecentSessions.
 * This tests the pure function behavior without file system access.
 */
describe('observe graph --days filtering', () => {
  // Helper to simulate the cutoff calculation
  const calculateCutoff = (days: number): number => {
    return days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0
  }

  // Simulate session filtering by mtime
  const filterByDays = (sessions: Array<{ mtime: number }>, days: number) => {
    const cutoff = calculateCutoff(days)
    if (cutoff === 0) return sessions
    return sessions.filter((s) => s.mtime >= cutoff)
  }

  it('filters sessions older than N days when days > 0', () => {
    const now = Date.now()
    const sessions = [
      { mtime: now - 1 * 24 * 60 * 60 * 1000 }, // 1 day ago - included
      { mtime: now - 2 * 24 * 60 * 60 * 1000 }, // 2 days ago - included
      { mtime: now - 5 * 24 * 60 * 60 * 1000 }, // 5 days ago - excluded
      { mtime: now - 10 * 24 * 60 * 60 * 1000 }, // 10 days ago - excluded
    ]

    const filtered = filterByDays(sessions, 3)
    expect(filtered).toHaveLength(2)
  })

  it('returns all sessions when days=0', () => {
    const now = Date.now()
    const sessions = [
      { mtime: now - 1 * 24 * 60 * 60 * 1000 },
      { mtime: now - 100 * 24 * 60 * 60 * 1000 },
      { mtime: now - 365 * 24 * 60 * 60 * 1000 },
    ]

    const filtered = filterByDays(sessions, 0)
    expect(filtered).toHaveLength(3)
  })

  it('default 7 days filters correctly', () => {
    const now = Date.now()
    const sessions = [
      { mtime: now - 1 * 24 * 60 * 60 * 1000 }, // 1 day ago - included
      { mtime: now - 6 * 24 * 60 * 60 * 1000 }, // 6 days ago - included
      { mtime: now - 8 * 24 * 60 * 60 * 1000 }, // 8 days ago - excluded
      { mtime: now - 30 * 24 * 60 * 60 * 1000 }, // 30 days ago - excluded
    ]

    const filtered = filterByDays(sessions, 7)
    expect(filtered).toHaveLength(2)
    // Verify the right sessions were kept
    expect(filtered[0].mtime).toBeGreaterThan(now - 7 * 24 * 60 * 60 * 1000)
    expect(filtered[1].mtime).toBeGreaterThan(now - 7 * 24 * 60 * 60 * 1000)
  })

  it('--days 1 filters to today only', () => {
    const now = Date.now()
    const sessions = [
      { mtime: now - 12 * 60 * 60 * 1000 }, // 12 hours ago - included
      { mtime: now - 25 * 60 * 60 * 1000 }, // 25 hours ago - excluded
    ]

    const filtered = filterByDays(sessions, 1)
    expect(filtered).toHaveLength(1)
  })
})
