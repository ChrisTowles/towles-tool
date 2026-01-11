import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../config/context'
import type { SettingsFile } from '../config/settings'

// Mock consola
vi.mock('consola', () => ({
  default: {
    info: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  },
}))

describe('config command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const createMockContext = (overrides: Partial<SettingsFile['settings']> = {}): Context => {
    const defaultSettings = {
      preferredEditor: 'code',
      journalSettings: {
        baseFolder: '/home/user',
        dailyPathTemplate: 'journal/{monday:yyyy}/daily.md',
        meetingPathTemplate: 'journal/{yyyy}/meetings/{title}.md',
        notePathTemplate: 'journal/{yyyy}/notes/{title}.md',
      },
    }
    return {
      cwd: '/test/working/dir',
      settingsFile: {
        path: '/home/user/.config/towles-tool/towles-tool.settings.json',
        settings: { ...defaultSettings, ...overrides },
      },
      args: [],
      debug: false,
    }
  }

  it('displays configuration header', async () => {
    const consola = await import('consola')
    const { configCommand } = await import('./config')

    const context = createMockContext()
    await configCommand(context)

    expect(consola.default.info).toHaveBeenCalledWith('Configuration')
  })

  it('displays settings file path', async () => {
    const consola = await import('consola')
    const { configCommand } = await import('./config')

    const context = createMockContext()
    await configCommand(context)

    expect(consola.default.info).toHaveBeenCalledWith(
      'Settings File: /home/user/.config/towles-tool/towles-tool.settings.json'
    )
  })

  it('displays daily path template', async () => {
    const consola = await import('consola')
    const { configCommand } = await import('./config')

    const context = createMockContext()
    await configCommand(context)

    expect(consola.default.log).toHaveBeenCalledWith(
      '  Daily Path Template: journal/{monday:yyyy}/daily.md'
    )
  })

  it('displays meeting path template', async () => {
    const consola = await import('consola')
    const { configCommand } = await import('./config')

    const context = createMockContext()
    await configCommand(context)

    expect(consola.default.log).toHaveBeenCalledWith(
      '  Meeting Path Template: journal/{yyyy}/meetings/{title}.md'
    )
  })

  it('displays note path template', async () => {
    const consola = await import('consola')
    const { configCommand } = await import('./config')

    const context = createMockContext()
    await configCommand(context)

    expect(consola.default.log).toHaveBeenCalledWith(
      '  Note Path Template: journal/{yyyy}/notes/{title}.md'
    )
  })

  it('displays preferred editor', async () => {
    const consola = await import('consola')
    const { configCommand } = await import('./config')

    const context = createMockContext()
    await configCommand(context)

    expect(consola.default.log).toHaveBeenCalledWith('  Editor: code')
  })

  it('displays working directory', async () => {
    const consola = await import('consola')
    const { configCommand } = await import('./config')

    const context = createMockContext()
    await configCommand(context)

    expect(consola.default.warn).toHaveBeenCalledWith('Working Directory:')
    expect(consola.default.log).toHaveBeenCalledWith('  /test/working/dir')
  })

  it('displays custom editor setting', async () => {
    const consola = await import('consola')
    const { configCommand } = await import('./config')

    const context = createMockContext({ preferredEditor: 'vim' })
    await configCommand(context)

    expect(consola.default.log).toHaveBeenCalledWith('  Editor: vim')
  })

  it('displays custom path templates', async () => {
    const consola = await import('consola')
    const { configCommand } = await import('./config')

    const context: Context = {
      cwd: '/projects',
      settingsFile: {
        path: '/custom/path/settings.json',
        settings: {
          preferredEditor: 'nvim',
          journalSettings: {
            baseFolder: '/notes',
            dailyPathTemplate: 'daily/{yyyy}-{MM}-{dd}.md',
            meetingPathTemplate: 'meetings/{yyyy}/{title}.md',
            notePathTemplate: 'notes/{title}.md',
          },
        },
      },
      args: [],
      debug: false,
    }

    await configCommand(context)

    expect(consola.default.info).toHaveBeenCalledWith(
      'Settings File: /custom/path/settings.json'
    )
    expect(consola.default.log).toHaveBeenCalledWith(
      '  Daily Path Template: daily/{yyyy}-{MM}-{dd}.md'
    )
    expect(consola.default.log).toHaveBeenCalledWith(
      '  Meeting Path Template: meetings/{yyyy}/{title}.md'
    )
    expect(consola.default.log).toHaveBeenCalledWith('  Note Path Template: notes/{title}.md')
    expect(consola.default.log).toHaveBeenCalledWith('  Editor: nvim')
    expect(consola.default.log).toHaveBeenCalledWith('  /projects')
  })

  it('displays User Config section header', async () => {
    const consola = await import('consola')
    const { configCommand } = await import('./config')

    const context = createMockContext()
    await configCommand(context)

    expect(consola.default.warn).toHaveBeenCalledWith('User Config:')
  })
})
