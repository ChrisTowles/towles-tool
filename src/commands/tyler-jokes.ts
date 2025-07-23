import type { Context } from '../config/context'
import consola from 'consola'
import { colors } from 'consola/utils'
import { confirm } from '@clack/prompts'

const JOKES = [
  "Why don't scientists trust atoms? Because they make up everything!",
  "I told my wife she was drawing her eyebrows too high. She looked surprised.",
  "Why don't skeletons fight each other? They don't have the guts.",
  "What do you call a fake noodle? An impasta!",
  "Why did the scarecrow win an award? He was outstanding in his field!"
] as const

/**
 * Tyler jokes command implementation
 * Shows 5 jokes with "Tyler small" prompts between them
 */
export async function tylerJokesCommand(context: Context): Promise<void> {
  try {
    consola.info(colors.cyan('🎭 Welcome to Tyler Jokes! Press Enter after each prompt to continue...\n'))
    
    for (let i = 0; i < JOKES.length; i++) {
      // Show the joke
      consola.box({
        title: `Joke ${i + 1}`,
        style: {
          borderColor: 'cyan',
          borderStyle: 'round'
        }
      }, JOKES[i])
      
      // If not the last joke, show "Tyler small" prompt
      if (i < JOKES.length - 1) {
        consola.log('')
        await confirm({
          message: colors.yellow('Tyler small'),
          initialValue: true
        })
        consola.log('') // Add spacing
      }
    }
    
    consola.success(colors.green('🎉 All 5 jokes complete! Hope you enjoyed them!'))
    
  } catch (error) {
    consola.error('Error running Tyler jokes command:', error)
    throw error
  }
}