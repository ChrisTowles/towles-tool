import type { Config } from '../config.js'
import { render } from 'ink'
import { GitCommit } from '../components/GitCommit.js'

/**
 * Git commit command implementation with enhanced ink interface
 */
export async function gitCommitCommand(config: Config, messageArgs?: string[]): Promise<void> {
  const { waitUntilExit } = render(
    <GitCommit 
      config={config} 
      messageArgs={messageArgs}
      onExit={() => process.exit(0)}
    />
  )
  
  await waitUntilExit()
}