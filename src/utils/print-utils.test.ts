import util from 'node:util'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import consola from 'consola'
import { printDebug, printJson } from './print-utils'

describe('print-utils', () => {
  let inspectSpy: ReturnType<typeof spyOn>
  let consolaLogSpy: ReturnType<typeof spyOn>
  let consolaDebugSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    inspectSpy = spyOn(util, 'inspect').mockReturnValue('mocked-inspect-output')
    consolaLogSpy = spyOn(consola, 'log').mockImplementation(() => {})
    consolaDebugSpy = spyOn(consola, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    inspectSpy.mockRestore()
    consolaLogSpy.mockRestore()
    consolaDebugSpy.mockRestore()
    delete process.env.DEBUG
  })

  describe('printJson', () => {
    it('should call consola.log with util.inspect output', () => {
      const testObj = { key: 'value', nested: { prop: 123 } }

      printJson(testObj)

      expect(inspectSpy).toHaveBeenCalledWith(testObj, {
        depth: 2,
        colors: true,
        showHidden: false,
        compact: false,
      })
      expect(consolaLogSpy).toHaveBeenCalledWith('mocked-inspect-output')
    })

    it('should handle empty objects', () => {
      const emptyObj = {}

      printJson(emptyObj)

      expect(inspectSpy).toHaveBeenCalledWith(emptyObj, expect.any(Object))
      expect(consolaLogSpy).toHaveBeenCalledWith('mocked-inspect-output')
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

      expect(inspectSpy).toHaveBeenCalledWith(complexObj, {
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

      expect(consolaDebugSpy).toHaveBeenCalledWith(`DEBUG: ${message}`, ...args)
    })

    it('should not log when DEBUG env var is not set', () => {
      const message = 'test debug message'
      const args = ['arg1', 'arg2']

      printDebug(message, ...args)

      expect(consolaDebugSpy).not.toHaveBeenCalled()
    })

    it('should not log when DEBUG env var is empty string', () => {
      process.env.DEBUG = ''
      const message = 'test debug message'

      printDebug(message)

      expect(consolaDebugSpy).not.toHaveBeenCalled()
    })

    it('should handle object messages', () => {
      process.env.DEBUG = 'true'
      const messageObj = { type: 'error', code: 500 }

      printDebug(messageObj)

      expect(consolaDebugSpy).toHaveBeenCalledWith(`DEBUG: ${messageObj}`)
    })

    it('should handle multiple arguments', () => {
      process.env.DEBUG = 'true'
      const message = 'test'
      const args = ['arg1', { key: 'value' }, 123]

      printDebug(message, ...args)

      expect(consolaDebugSpy).toHaveBeenCalledWith(`DEBUG: ${message}`, ...args)
    })
  })
})
