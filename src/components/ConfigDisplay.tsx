import { Box, Text } from 'ink'
import type { Context } from '../config/context'

interface ConfigDisplayProps {
  context: Context
}

export function ConfigDisplay({ context }: ConfigDisplayProps) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="green">Configuration</Text>
      <Box marginTop={1}>
        <Text color="cyan">Settings File: </Text>
        <Text>{context.settingsFile.path}</Text>
      </Box>
      
      <Box marginTop={1} flexDirection="column">
        <Text bold color="yellow">User Config:</Text>
        <Box marginLeft={2} marginTop={1} flexDirection="column">
          <Box>
            <Text color="cyan">Daily Path Template: </Text>
            <Text>{context.settingsFile.settings.journalSettings.dailyPathTemplate}</Text>
          </Box>
          <Box>
            <Text color="cyan">Meeting Path Template: </Text>
            <Text>{context.settingsFile.settings.journalSettings.meetingPathTemplate}</Text>
          </Box>
          <Box>
            <Text color="cyan">Note Path Template: </Text>
            <Text>{context.settingsFile.settings.journalSettings.notePathTemplate}</Text>
          </Box>
          <Box>
            <Text color="cyan">Editor: </Text>
            <Text>{context.settingsFile.settings.preferredEditor}</Text>
          </Box>
        </Box>
      </Box>
      
      <Box marginTop={1} flexDirection="column">
        <Text bold color="yellow">Working Directory:</Text>
        <Box marginLeft={2} marginTop={1}>
          <Text>{context.cwd}</Text>
        </Box>
      </Box>
    </Box>
  )
}