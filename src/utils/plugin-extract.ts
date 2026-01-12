import * as fs from 'node:fs'
import * as path from 'node:path'
import consola from 'consola'
import { exec } from 'tinyexec'

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

  // Extract zip using system unzip command (tinyexec uses execFile internally - safe from injection)
  const result = await exec('unzip', ['-o', '-q', zipPath, '-d', destDir])
  if (result.exitCode !== 0) {
    throw new Error(`Failed to extract: ${result.stderr}`)
  }

  consola.success(`Extracted plugin to ${destDir}`)
  return true
}
