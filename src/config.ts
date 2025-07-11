import { homedir } from 'node:os'
import * as path from 'node:path'
import process from 'node:process'

import { loadConfig, setupDotenv } from 'c12'
import { updateConfig } from 'c12/update'

import consola from 'consola'

import { colors } from 'consola/utils'
import { constants } from './constants.js'
import { printDebug } from './utils/print-utils.js'

export interface TowlesToolConfig {
  journalDir?: string
  editor?: string
}

// for now no reason to have a separate types, https://github.com/unjs/changelogen/blob/acdedaaa2d1cfdb37a6e91edf9f30fd654461e22/src/config.ts#L34
interface ResolvedTowlesToolConfig {
  configFile?: string
  cwd: string
  config: TowlesToolConfig
}

function getDefaultConfig() {
  return <TowlesToolConfig>{
    journalDir: path.join(homedir(), 'journal'),
    editor: 'code',
    debug: false,
  }
}

export async function loadTowlesToolConfig({
  cwd,
  overrides,
}: {
  cwd: string
  overrides?: Partial<TowlesToolConfig>
}): Promise<ResolvedTowlesToolConfig> {
  await setupDotenv({ cwd })
  const defaults = getDefaultConfig()
  const defaultConfigFolder = path.join(homedir(), '.config', constants.toolName)

  const updateResult = await updateConfig({
    cwd: defaultConfigFolder,

    configFile: `${constants.toolName}.config`,
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
    // async onUpdate(config) {
    //   consola.info(`Configuration updated in ${colors.cyan(path.relative('.', configFile))}`)
    //   return config
    // },
  }).catch((error) => {
    consola.error(`Failed to update config: ${error.message}`)
    return null
  })

  if (!updateResult?.configFile) {
    consola.error(`Failed to load or update config. Please check your configuration.`)

    process.exit(1)
  }

  const { config, configFile } = await loadConfig<TowlesToolConfig>({
    cwd: cwd || defaultConfigFolder,
    configFile: updateResult.configFile,
    name: constants.toolName,
    packageJson: true,

    defaults,
    overrides: {
      // cwd,
      ...(overrides as TowlesToolConfig),
    },
  })

  printDebug(`Using config from: ${colors.cyan(configFile!)}`)

  return await resolveTowlesToolConfig(config, configFile!, cwd)
}

export async function resolveTowlesToolConfig(
  config: TowlesToolConfig,
  configFile: string,
  cwd: string,
): Promise<ResolvedTowlesToolConfig> {
  return {
    configFile,
    config,
    cwd,
  } satisfies ResolvedTowlesToolConfig
}
