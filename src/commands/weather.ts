import consola from 'consola'
import type { Context } from '../config/context.js'

// Cincinnati coordinates
const CINCINNATI_LATITUDE = 39.1031
const CINCINNATI_LONGITUDE = -84.5120

interface CurrentWeather {
  temperature: number
  windspeed: number
  winddirection: number
  weathercode: number
  is_day: number
  time: string
}

interface WeatherResponse {
  current_weather: CurrentWeather
  current_weather_units: {
    temperature: string
    windspeed: string
    winddirection: string
    weathercode: string
    is_day: string
    time: string
  }
}

// Weather code mappings based on WMO Weather interpretation codes
const WEATHER_DESCRIPTIONS: Record<number, { description: string; emoji: string }> = {
  0: { description: 'Clear sky', emoji: '☀️' },
  1: { description: 'Mainly clear', emoji: '🌤️' },
  2: { description: 'Partly cloudy', emoji: '⛅' },
  3: { description: 'Overcast', emoji: '☁️' },
  45: { description: 'Fog', emoji: '🌫️' },
  48: { description: 'Depositing rime fog', emoji: '🌫️' },
  51: { description: 'Light drizzle', emoji: '🌦️' },
  53: { description: 'Moderate drizzle', emoji: '🌦️' },
  55: { description: 'Dense drizzle', emoji: '🌧️' },
  56: { description: 'Light freezing drizzle', emoji: '🌨️' },
  57: { description: 'Dense freezing drizzle', emoji: '🌨️' },
  61: { description: 'Slight rain', emoji: '🌧️' },
  63: { description: 'Moderate rain', emoji: '🌧️' },
  65: { description: 'Heavy rain', emoji: '🌧️' },
  66: { description: 'Light freezing rain', emoji: '🌨️' },
  67: { description: 'Heavy freezing rain', emoji: '🌨️' },
  71: { description: 'Slight snow fall', emoji: '🌨️' },
  73: { description: 'Moderate snow fall', emoji: '❄️' },
  75: { description: 'Heavy snow fall', emoji: '❄️' },
  77: { description: 'Snow grains', emoji: '🌨️' },
  80: { description: 'Slight rain showers', emoji: '🌦️' },
  81: { description: 'Moderate rain showers', emoji: '🌧️' },
  82: { description: 'Violent rain showers', emoji: '⛈️' },
  85: { description: 'Slight snow showers', emoji: '🌨️' },
  86: { description: 'Heavy snow showers', emoji: '❄️' },
  95: { description: 'Thunderstorm', emoji: '⛈️' },
  96: { description: 'Thunderstorm with slight hail', emoji: '⛈️' },
  99: { description: 'Thunderstorm with heavy hail', emoji: '⛈️' }
}

function getWindDirection(degrees: number): string {
  const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  const index = Math.round(degrees / 22.5) % 16
  return directions[index]
}

function formatWeatherData(data: WeatherResponse): void {
  const { current_weather: weather, current_weather_units: units } = data
  const weatherInfo = WEATHER_DESCRIPTIONS[weather.weathercode] || { 
    description: 'Unknown', 
    emoji: '❓' 
  }
  
  const windDirection = getWindDirection(weather.winddirection)
  const timeOfDay = weather.is_day ? 'Day' : 'Night'
  
  consola.info('🌎 Current Weather in Cincinnati, OH')
  consola.log('')
  consola.log(`${weatherInfo.emoji} ${weatherInfo.description}`)
  consola.log(`🌡️  Temperature: ${weather.temperature}${units.temperature}`)
  consola.log(`💨 Wind: ${weather.windspeed} ${units.windspeed} ${windDirection}`)
  consola.log(`🕐 Time: ${new Date(weather.time).toLocaleTimeString()} (${timeOfDay})`)
}

/**
 * Weather command implementation - shows current weather for Cincinnati, OH
 */
export async function weatherCommand(context: Context): Promise<void> {
  try {
    consola.start('Fetching current weather for Cincinnati...')
    
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${CINCINNATI_LATITUDE}&longitude=${CINCINNATI_LONGITUDE}&current_weather=true&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=America/New_York`
    
    const response = await fetch(url)
    
    if (!response.ok) {
      throw new Error(`Weather API request failed: ${response.status} ${response.statusText}`)
    }
    
    const data = await response.json() as WeatherResponse
    
    if (!data.current_weather) {
      throw new Error('No weather data received from API')
    }
    
    consola.success('Weather data retrieved successfully!')
    consola.log('')
    
    formatWeatherData(data)
    
  } catch (error) {
    consola.error('Failed to fetch weather data:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}