import * as fs from 'node:fs'
import * as path from 'node:path'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import unzipper from 'unzipper'
import consola from 'consola'

/**
 * Extracts a plugin zip to destination directory.
 * Prompts user for confirmation if dest already exists.
 * @returns true if extracted, false if user cancelled
 */
export async function extractPlugin(zipPath: string, destDir: string): Promise<boolean> {
  // Check if destination exists
  if (fs.existsSync(destDir)) {
    const answer = await consola.prompt(`Plugin directory exists: ${destDir}\nOverwrite?`, {
      type: 'confirm',
      initial: false,
    })
    if (!answer) {
      consola.info('Extraction cancelled')
      return false
    }
    // Remove existing directory
    fs.rmSync(destDir, { recursive: true })
  }

  // Create parent directory if needed
  const parentDir = path.dirname(destDir)
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true })
  }

  // Extract zip
  await pipeline(
    createReadStream(zipPath),
    unzipper.Extract({ path: destDir })
  )

  consola.success(`Extracted plugin to ${destDir}`)
  return true
}
