import type { Context } from '../config/context'
import consola from 'consola'
import { colors } from 'consola/utils'

/**
 * Collection of programming/tech jokes
 */
const PROGRAMMING_JOKES = [
  "Why do programmers prefer dark mode? Because light attracts bugs! 🐛",
  "How many programmers does it take to change a light bulb? None – that's a hardware problem! 💡",
  "Why don't programmers like nature? It has too many bugs! 🌲",
  "What's a programmer's favorite hangout place? Foo Bar! 🍺",
  "Why did the programmer quit his job? He didn't get arrays! 💰",
  "How do you comfort a JavaScript bug? You console it! 🐞",
  "Why do Java developers wear glasses? Because they can't C#! 👓",
  "What do you call a programmer from Finland? Nerdic! 🇫🇮",
  "Why did the developer go broke? Because he used up all his cache! 💸",
  "What's the object-oriented way to become wealthy? Inheritance! 💎"
] as const

/**
 * Get 5 random jokes from the collection
 */
export function getRandomJokes(): string[] {
  const shuffled = [...PROGRAMMING_JOKES].sort(() => 0.5 - Math.random())
  return shuffled.slice(0, 5)
}

/**
 * Format joke output with Tyler reference
 */
export function formatJokeOutput(jokes: string[]): string {
  const output: string[] = []
  
  output.push(colors.cyan('🎭 Tyler\'s Tech Joke Collection 🎭'))
  output.push('')
  output.push('Here are 5 random programming jokes to brighten your day:')
  output.push('')

  jokes.forEach((joke, index) => {
    output.push(`${colors.yellow(`${index + 1}.`)} ${joke}`)
    output.push('')
  })

  output.push(colors.dim('Hope these made you smile! Keep coding! 😄'))
  
  return output.join('\n')
}

/**
 * Main jokes command implementation
 */
export async function jokesCommand(context: Context): Promise<void> {
  try {
    const jokes = getRandomJokes()
    const formattedOutput = formatJokeOutput(jokes)
    
    consola.log(formattedOutput)
    
    if (context.debug) {
      consola.info('Debug: Jokes command executed successfully')
    }
  } catch (error) {
    consola.error('Error displaying jokes:', error)
    throw error
  }
}