
import type { Config } from '../config/config.js'
import { renderApp } from '../App.js'

export async function configCommand(config: Config) {
  const { waitUntilExit } = renderApp({
    config,
    command: 'config'
  })
  await waitUntilExit()
}