import { homedir } from 'node:os'
import * as path from 'node:path'
import process from 'node:process'

import { loadConfig, setupDotenv } from 'c12'
import { updateConfig } from 'c12/update'

import consola from 'consola'

import { colors } from 'consola/utils'
import { AppInfo } from '../constants.js'
import { printDebug } from '../utils/print-utils.js'

export interface UserConfig {
  journalDir: string
  editor: string
}

// for now no reason to have a separate types, https://github.com/unjs/changelogen/blob/acdedaaa2d1cfdb37a6e91edf9f30fd654461e22/src/config.ts#L34
export interface Config {
  configFile: string
  cwd: string
  userConfig: UserConfig
}

function getDefaultUserConfig() {
  return <UserConfig>{
    journalDir: path.join(homedir(), 'journal'),
    editor: 'code',
  }
}

export async function loadTowlesToolConfig({
  cwd,
  overrides,
}: {
  cwd: string
  overrides?: Partial<UserConfig>
}): Promise<Config> {
  await setupDotenv({ cwd })
  const defaults = getDefaultUserConfig()
  const defaultConfigFolder = path.join(homedir(), '.config', AppInfo.toolName)

  const updateResult = await updateConfig({
    cwd: defaultConfigFolder,

    configFile: `${AppInfo.toolName}.config`,
    createExtension: '.ts',

    async onCreate({ configFile }) {
      const shallCreate = await consola.prompt(
        `Do you want to initialize a new config in ${colors.cyan(configFile)}?`,
        {
          type: 'confirm',
          default: true,
        },
      )
      if (shallCreate !== true) {
        return false
      }
      return `
// Default configuration for Towles Tool
// You can customize these values to fit your needs
// cwd: null means it will use the current working directory
export default  ${JSON.stringify(defaults, null, 2)};
`
    },
    async onUpdate(config) {
      // update the config to sync with the defaults
      // TODO: add zod to validate the config

      // consola.info(`Configuration updated in ${colors.cyan(path.relative('.', configFile))}`)
      return config
    },
  }).catch((error) => {
    consola.error(`Failed to update config: ${error.message}`)
    return null
  })

  if (!updateResult?.configFile) {
    consola.error(`Failed to load or update config. Please check your configuration.`)

    process.exit(1)
  }

  const { config: userConfig, configFile } = await loadConfig<UserConfig>({
    cwd: cwd || defaultConfigFolder,
    configFile: updateResult.configFile,
    name: AppInfo.toolName,
    packageJson: true,

    defaults,
    overrides: {
      // cwd,
      ...(overrides as UserConfig),
    },
  })

  printDebug(`Using config from: ${colors.cyan(configFile!)}`)

  return {
    configFile: configFile!,
    cwd: cwd!,
    userConfig,
  } satisfies Config
}
