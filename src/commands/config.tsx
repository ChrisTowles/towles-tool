
import type { Config } from '../config.js'
import { renderApp } from '../ui/App.js'

export async function configCommand(config: Config) {
  const { waitUntilExit } = renderApp({
    config,
    command: 'config'
  })
  await waitUntilExit()
}