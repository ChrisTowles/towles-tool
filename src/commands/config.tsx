
import type { Context } from '../config/context.js'
import { renderApp } from '../App.js'

export async function configCommand(context: Context) {
  const { waitUntilExit } = renderApp({
    context,
    command: 'config'
  })
  await waitUntilExit()
}