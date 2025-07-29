import type { Context } from '../config/context'
import consola from 'consola'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { weatherCommand } from './weather'

// Mock consola
vi.mock('consola')
const mockConsola = vi.mocked(consola)

// Mock fetch globally
globalThis.fetch = vi.fn()
const mockFetch = vi.mocked(fetch)

describe('weather command', () => {
  const mockContext: Context = {
    settingsFile: {
      settings: {
        preferredEditor: 'code',
        journalSettings: {
          dailyPathTemplate: '/test/path',
          meetingPathTemplate: '/test/path',
          notePathTemplate: '/test/path'
        }
      },
      path: '/test/settings.json',
    },
    cwd: '/test',
    args: [],
    debug: false,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should fetch and display weather data successfully', async () => {
    const mockWeatherResponse = {
      current_weather: {
        temperature: 75.5,
        windspeed: 10.2,
        winddirection: 180,
        weathercode: 0,
        is_day: 1,
        time: '2024-01-01T12:00:00'
      },
      current_weather_units: {
        temperature: '°F',
        windspeed: 'mph',
        winddirection: '°',
        weathercode: '',
        is_day: '',
        time: ''
      }
    }

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockWeatherResponse)
    } as Response)

    await weatherCommand(mockContext)

    expect(mockFetch).toHaveBeenCalledOnce()
    const fetchUrl = mockFetch.mock.calls[0][0] as string
    expect(fetchUrl).toContain('api.open-meteo.com/v1/forecast')
    expect(fetchUrl).toContain('latitude=39.1031')
    expect(fetchUrl).toContain('longitude=-84.512')
    expect(fetchUrl).toContain('current_weather=true')
    expect(fetchUrl).toContain('temperature_unit=fahrenheit')

    expect(mockConsola.start).toHaveBeenCalledWith('Fetching current weather for Cincinnati...')
    expect(mockConsola.success).toHaveBeenCalledWith('Weather data retrieved successfully!')
    expect(mockConsola.info).toHaveBeenCalledWith('🌎 Current Weather in Cincinnati, OH')
    expect(mockConsola.log).toHaveBeenCalledWith('☀️ Clear sky')
    expect(mockConsola.log).toHaveBeenCalledWith('🌡️  Temperature: 75.5°F')
    expect(mockConsola.log).toHaveBeenCalledWith('💨 Wind: 10.2 mph S')
    expect(mockConsola.log).toHaveBeenCalledWith(expect.stringContaining('🕐 Time:'))
  })

  it('should handle API errors gracefully', async () => {
    const mockExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error'
    } as Response)

    await expect(weatherCommand(mockContext)).rejects.toThrow('process.exit called')

    expect(mockConsola.start).toHaveBeenCalledWith('Fetching current weather for Cincinnati...')
    expect(mockConsola.error).toHaveBeenCalledWith(
      'Failed to fetch weather data:',
      'Weather API request failed: 500 Internal Server Error'
    )
    expect(mockExitSpy).toHaveBeenCalledWith(1)

    mockExitSpy.mockRestore()
  })

  it('should handle network errors gracefully', async () => {
    const mockExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })

    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    await expect(weatherCommand(mockContext)).rejects.toThrow('process.exit called')

    expect(mockConsola.start).toHaveBeenCalledWith('Fetching current weather for Cincinnati...')
    expect(mockConsola.error).toHaveBeenCalledWith(
      'Failed to fetch weather data:',
      'Network error'
    )
    expect(mockExitSpy).toHaveBeenCalledWith(1)

    mockExitSpy.mockRestore()
  })

  it('should handle missing weather data in response', async () => {
    const mockExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}) // Empty response
    } as Response)

    await expect(weatherCommand(mockContext)).rejects.toThrow('process.exit called')

    expect(mockConsola.error).toHaveBeenCalledWith(
      'Failed to fetch weather data:',
      'No weather data received from API'
    )
    expect(mockExitSpy).toHaveBeenCalledWith(1)

    mockExitSpy.mockRestore()
  })
})