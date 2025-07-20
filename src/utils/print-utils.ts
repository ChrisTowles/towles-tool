import type { InputLogObject } from 'consola'
import process from 'node:process'
import util from 'node:util'
import consola from 'consola'

// todo we could use tags.
// const consola = _consola.withTag(AppInfo.toolName)

export function printJson(obj: object): void {
  consola.log(util.inspect(obj, {
    depth: 2,
    colors: true,
    showHidden: false,
    compact: false,
  }))
}

export function printDebug(message: InputLogObject | any, ...args: any[]): void {
  if (process.env.DEBUG) {
    consola.debug(`DEBUG: ${message}`, ...args)
  }
}
