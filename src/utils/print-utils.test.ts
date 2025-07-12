import util from 'node:util'
import consola from 'consola'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { printDebug, printJson } from './print-utils'

vi.mock('consola')
vi.mock('node:util')

describe('print-utils', () => {
  const mockConsola = vi.mocked(consola)
  const mockInspect = vi.mocked(util.inspect)

  beforeEach(() => {
    vi.clearAllMocks()
    mockInspect.mockReturnValue('mocked-inspect-output')
  })

  afterEach(() => {
    delete process.env.DEBUG
  })

  describe('printJson', () => {
    it('should call consola.log with util.inspect output', () => {
      const testObj = { key: 'value', nested: { prop: 123 } }

      printJson(testObj)

      expect(mockInspect).toHaveBeenCalledWith(testObj, {
        depth: 2,
        colors: true,
        showHidden: false,
        compact: false,
      })
      expect(mockConsola.log).toHaveBeenCalledWith('mocked-inspect-output')
    })

    it('should handle empty objects', () => {
      const emptyObj = {}

      printJson(emptyObj)

      expect(mockInspect).toHaveBeenCalledWith(emptyObj, expect.any(Object))
      expect(mockConsola.log).toHaveBeenCalledWith('mocked-inspect-output')
    })

    it('should handle complex nested objects', () => {
      const complexObj = {
        array: [1, 2, 3],
        nested: {
          deep: {
            value: 'test',
          },
        },
        func: () => 'test',
      }

      printJson(complexObj)

      expect(mockInspect).toHaveBeenCalledWith(complexObj, {
        depth: 2,
        colors: true,
        showHidden: false,
        compact: false,
      })
    })
  })

  describe('printDebug', () => {
    it('should log debug message when DEBUG env var is set', () => {
      process.env.DEBUG = 'true'
      const message = 'test debug message'
      const args = ['arg1', 'arg2']

      printDebug(message, ...args)

      expect(mockConsola.log).toHaveBeenCalledWith(`DEBUG: ${message}`, ...args)
    })

    it('should not log when DEBUG env var is not set', () => {
      const message = 'test debug message'
      const args = ['arg1', 'arg2']

      printDebug(message, ...args)

      expect(mockConsola.log).not.toHaveBeenCalled()
    })

    it('should not log when DEBUG env var is empty string', () => {
      process.env.DEBUG = ''
      const message = 'test debug message'

      printDebug(message)

      expect(mockConsola.log).not.toHaveBeenCalled()
    })

    it('should handle object messages', () => {
      process.env.DEBUG = 'true'
      const messageObj = { type: 'error', code: 500 }

      printDebug(messageObj)

      expect(mockConsola.log).toHaveBeenCalledWith(`DEBUG: ${messageObj}`)
    })

    it('should handle multiple arguments', () => {
      process.env.DEBUG = 'true'
      const message = 'test'
      const args = ['arg1', { key: 'value' }, 123]

      printDebug(message, ...args)

      expect(mockConsola.log).toHaveBeenCalledWith(`DEBUG: ${message}`, ...args)
    })
  })
})
