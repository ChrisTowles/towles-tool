
import type { Config } from '../config.js'
import { ConfigDisplay } from '../components/ConfigDisplay.js'
import { render } from 'ink'

export async function configCommand(config: Config) {
      const { waitUntilExit } = render(<ConfigDisplay config={config} />)
      await waitUntilExit()
}