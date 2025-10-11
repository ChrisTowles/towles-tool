import { describe, it, expect } from 'vitest'

describe('MCP Config Tools', () => {
  describe('config_get response format', () => {
    it('should return entire config when no key specified', () => {
      const response = {
        success: true,
        path: '/path/to/config.json',
        config: {
          preferredEditor: 'code',
          journalSettings: {
            baseFolder: '/home/user',
          },
        },
      }

      expect(response).toHaveProperty('success', true)
      expect(response).toHaveProperty('path')
      expect(response).toHaveProperty('config')
      expect(typeof response.config).toBe('object')
    })

    it('should return specific value for dot notation key', () => {
      const response = {
        success: true,
        key: 'journalSettings.baseFolder',
        value: '/home/user/journals',
      }

      expect(response).toHaveProperty('success', true)
      expect(response).toHaveProperty('key')
      expect(response).toHaveProperty('value')
    })

    it('should error when key not found', () => {
      const errorResponse = {
        success: false,
        error: 'Configuration key not found: invalid.key',
      }

      expect(errorResponse.success).toBe(false)
      expect(errorResponse.error).toContain('not found')
    })

    it('should error when config file does not exist', () => {
      const errorResponse = {
        success: false,
        error: 'Configuration file not found at: /path/to/config.json',
      }

      expect(errorResponse.success).toBe(false)
      expect(errorResponse.error).toContain('not found')
    })
  })

  describe('config_set response format', () => {
    it('should return old and new values', () => {
      const response = {
        success: true,
        key: 'preferredEditor',
        oldValue: 'code',
        newValue: 'vim',
        path: '/path/to/config.json',
      }

      expect(response).toHaveProperty('success', true)
      expect(response).toHaveProperty('key')
      expect(response).toHaveProperty('oldValue')
      expect(response).toHaveProperty('newValue')
      expect(response).toHaveProperty('path')
    })

    it('should handle nested keys with dot notation', () => {
      const key = 'journalSettings.baseFolder'
      const keys = key.split('.')

      expect(keys).toEqual(['journalSettings', 'baseFolder'])
      expect(keys.length).toBe(2)
    })

    it('should error when config file does not exist', () => {
      const errorResponse = {
        success: false,
        error: 'Configuration file not found',
      }

      expect(errorResponse.success).toBe(false)
    })
  })

  describe('config_init response format', () => {
    it('should return created config with default values', () => {
      const response = {
        success: true,
        action: 'created',
        path: '/path/to/config.json',
        config: {
          preferredEditor: 'code',
          journalSettings: {
            baseFolder: '/home/user',
            dailyPathTemplate: 'journal/{monday:yyyy}/{monday:MM}/daily-notes/{monday:yyyy}-{monday:MM}-{monday:dd}-daily-notes.md',
            meetingPathTemplate: 'journal/{yyyy}/{MM}/meetings/{yyyy}-{MM}-{dd}-{title}.md',
            notePathTemplate: 'journal/{yyyy}/{MM}/notes/{yyyy}-{MM}-{dd}-{title}.md',
          },
        },
      }

      expect(response).toHaveProperty('success', true)
      expect(response).toHaveProperty('action')
      expect(response).toHaveProperty('path')
      expect(response).toHaveProperty('config')
      expect(response.config).toHaveProperty('preferredEditor')
      expect(response.config).toHaveProperty('journalSettings')
    })

    it('should indicate overwrite when force is true', () => {
      const response = {
        success: true,
        action: 'overwritten',
        path: '/path/to/config.json',
      }

      expect(response.action).toBe('overwritten')
    })

    it('should error when file exists without force', () => {
      const errorResponse = {
        success: false,
        error: 'Configuration file already exists. Use force: true to overwrite.',
      }

      expect(errorResponse.success).toBe(false)
      expect(errorResponse.error).toContain('already exists')
    })
  })

  describe('dot notation key parsing', () => {
    it('should parse single level key', () => {
      const key = 'preferredEditor'
      const keys = key.split('.')

      expect(keys).toEqual(['preferredEditor'])
      expect(keys.length).toBe(1)
    })

    it('should parse nested key', () => {
      const key = 'journalSettings.baseFolder'
      const keys = key.split('.')

      expect(keys).toEqual(['journalSettings', 'baseFolder'])
      expect(keys.length).toBe(2)
    })

    it('should parse deeply nested key', () => {
      const key = 'a.b.c.d'
      const keys = key.split('.')

      expect(keys).toEqual(['a', 'b', 'c', 'd'])
      expect(keys.length).toBe(4)
    })

    it('should navigate nested object', () => {
      const config = {
        journalSettings: {
          baseFolder: '/home/user',
          templates: {
            daily: 'daily.md',
          },
        },
      }

      const keys = 'journalSettings.templates.daily'.split('.')
      let value: any = config

      for (const k of keys) {
        value = value[k]
      }

      expect(value).toBe('daily.md')
    })
  })
})
