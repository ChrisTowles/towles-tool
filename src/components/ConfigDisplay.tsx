import { Box, Text } from 'ink'
import type { Config } from '../../config.js'

interface ConfigDisplayProps {
  config: Config
}

export function ConfigDisplay({ config }: ConfigDisplayProps) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="green">Configuration</Text>
      <Box marginTop={1}>
        <Text color="cyan">Settings File: </Text>
        <Text>{config.configFile}</Text>
      </Box>
      
      <Box marginTop={1} flexDirection="column">
        <Text bold color="yellow">User Config:</Text>
        <Box marginLeft={2} marginTop={1} flexDirection="column">
          <Box>
            <Text color="cyan">Journal Directory: </Text>
            <Text>{config.userConfig.journalDir}</Text>
          </Box>
          <Box>
            <Text color="cyan">Editor: </Text>
            <Text>{config.userConfig.editor}</Text>
          </Box>
        </Box>
      </Box>
      
      <Box marginTop={1} flexDirection="column">
        <Text bold color="yellow">Working Directory:</Text>
        <Box marginLeft={2} marginTop={1}>
          <Text>{config.cwd}</Text>
        </Box>
      </Box>
    </Box>
  )
}