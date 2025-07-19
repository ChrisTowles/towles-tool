## CLI Architecture Patterns

### Command Registration

in the `src/index.ts` file, commands are registered using the `commander` library. Each command is defined with its own logic and can have aliases for easier access. For example, the `config` command is registered as follows:

```typescript
// src/index.ts

import { Command } from 'commander'
import { configCommand } from './commands/config.js'
import { gitCommitCommand } from './commands/git-commit.js'

const program = new Command()

// Simple command
program
  .command('config')
  .alias('cfg')
  .description('set or show configuration file.')
  .action(async () => {
    await configCommand(config)
  })

// Command with parameters
program
  .command('git-commit [message...]')
  .alias('gc')
  .description('Git commit command with optional message')
  .action(async (message: string[]) => {
    await gitCommitCommand(config, message)
  })
```