import consola from 'consola'
import { colors } from 'consola/utils'
import type { Config } from '../config.js'
import { printJson } from '../utils/print-utils.js'

export async function configCommand(config: Config) {
  consola.log(colors.green('Showing configuration...'))
  consola.log('Settings File:', config.configFile)
  printJson(config)
}