import consola from 'consola'
import type { Context } from '../config/context.js'

const PUPPY_ASCII_ART = `
     /^   ^\\
    /  o o  \\
   |    Y    |
    \\   ~   /
     | (_) |
    /       \\
   /  \\   /  \\
  /    \\_/    \\
 /              \\
|     WOOF!      |
 \\______________/
`

const JOKES = [
  "Why don't scientists trust atoms? Because they make up everything!",
  "What do you call a fake noodle? An impasta!",
  "Why did the scarecrow win an award? He was outstanding in his field!",
  "What do you call a bear with no teeth? A gummy bear!",
  "Why don't eggs tell jokes? They'd crack each other up!"
]

export async function eatCommand(context: Context) {
  consola.info('🐶 Here\'s your puppy!')
  consola.log(PUPPY_ASCII_ART)
  consola.log('')
  
  consola.info('🎭 And here are five jokes to brighten your day:')
  consola.log('')
  
  JOKES.forEach((joke, index) => {
    consola.log(`${index + 1}. ${joke}`)
  })
  
  consola.log('')
  consola.success('Hope that made you smile! 😊')
}