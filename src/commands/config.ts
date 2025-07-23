
import consola from 'consola'
import type { Context } from '../config/context.js'

export async function configCommand(context: Context) {
  consola.info('Configuration')
  consola.log('')
  
  consola.info(`Settings File: ${context.settingsFile.path}`)
  consola.log('')
  
  consola.warn('User Config:')
  consola.log(`  Daily Path Template: ${context.settingsFile.settings.journalSettings.dailyPathTemplate}`)
  consola.log(`  Meeting Path Template: ${context.settingsFile.settings.journalSettings.meetingPathTemplate}`)
  consola.log(`  Note Path Template: ${context.settingsFile.settings.journalSettings.notePathTemplate}`)
  consola.log(`  Editor: ${context.settingsFile.settings.preferredEditor}`)
  consola.log('')
  
  consola.warn('Working Directory:')
  consola.log(`  ${context.cwd}`)
}