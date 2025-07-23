import consola from 'consola'
import type { Context } from '../config/context.js'

const puppyArt = `
     /^-----^\\
    /  o   o  \\
   /     ^     \\
  |  \\  ---  /  |
   \\  '-._.-'  /
    \\         /
     \\_______/
      |     |
      |  |  |
     /   |   \\
    (___|___)
`

const jokes = [
  "Why don't scientists trust atoms? Because they make up everything!",
  "Why did the scarecrow win an award? Because he was outstanding in his field!",
  "What do you call a fake noodle? An impasta!",
  "Why don't eggs tell jokes? They'd crack each other up!",
  "What did the ocean say to the beach? Nothing, it just waved!"
]

/**
 * Eat command implementation - displays a cute puppy and tells five jokes
 */
export async function eatCommand(context: Context): Promise<void> {
  try {
    consola.info('🐶 Here\'s a cute puppy for you!')
    consola.log(puppyArt)
    
    consola.info('🎭 And here are five jokes to brighten your day:')
    consola.log('')
    
    jokes.forEach((joke, index) => {
      consola.success(`${index + 1}. ${joke}`)
    })
    
    consola.log('')
    consola.info('Hope that made you smile! 😊')
    
  } catch (error) {
    consola.error('Eat command failed:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}