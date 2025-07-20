import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { Key as InkKeyType } from 'ink'
import { useApp } from '../contexts/AppContext.js'
import { useChat } from '../hooks/useChat.js'
import { DEFAULT_THEME } from '../constants.js'

interface ChatProps {
  onExit: () => void
}

export function Chat({ onExit }: ChatProps) {
  const { chatState } = useApp()
  const { sendMessage, updateInput } = useChat()
  const [inputBuffer, setInputBuffer] = useState('')

  useInput((input: string, key: InkKeyType) => {
    if (key.escape) {
      onExit()
      return
    }

    if (key.return) {
      if (inputBuffer.trim()) {
        sendMessage(inputBuffer.trim())
        setInputBuffer('')
        updateInput('')
      }
      return
    }

    if (key.backspace || key.delete) {
      const newInput = inputBuffer.slice(0, -1)
      setInputBuffer(newInput)
      updateInput(newInput)
      return
    }

    if (input && !key.ctrl && !key.meta) {
      const newInput = inputBuffer + input
      setInputBuffer(newInput)
      updateInput(newInput)
    }
  })

  return (
    <Box flexDirection="column" padding={1} height="100%">
      <Text bold color={DEFAULT_THEME.primary}>Interactive Chat</Text>
      
      {/* Messages */}
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {chatState.messages.length === 0 ? (
          <Text color={DEFAULT_THEME.dim}>Start a conversation by typing a message...</Text>
        ) : (
          chatState.messages.map((message) => (
            <Box key={message.id} marginBottom={1} flexDirection="column">
              <Text bold color={message.role === 'user' ? DEFAULT_THEME.primary : DEFAULT_THEME.secondary}>
                {message.role === 'user' ? 'You' : 'Assistant'}:
              </Text>
              <Text>
                {message.content}
                {message.isStreaming && (
                  <Text color={DEFAULT_THEME.dim}>█</Text>
                )}
              </Text>
            </Box>
          ))
        )}
        
        {/* Streaming message */}
        {chatState.isStreaming && chatState.streamingMessageId && (
          <Box marginBottom={1} flexDirection="column">
            <Text bold color={DEFAULT_THEME.secondary}>Assistant:</Text>
            <Text>
              {chatState.messages.find(m => m.id === chatState.streamingMessageId)?.content || ''}
              <Text color={DEFAULT_THEME.dim}>█</Text>
            </Text>
          </Box>
        )}
      </Box>

      {/* Input area */}
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={DEFAULT_THEME.primary}>{'> '}</Text>
          <Text>{inputBuffer}</Text>
          <Text color={DEFAULT_THEME.dim}>█</Text>
        </Box>
        <Text color={DEFAULT_THEME.dim}>
          Type your message and press Enter to send. Press ESC to exit.
        </Text>
      </Box>
    </Box>
  )
}