import { useCallback } from 'react'
import { useApp } from '../contexts/AppContext.js'
import type { Message } from '../types.js'

// Mock API client - replace with actual implementation
async function mockChatAPI(message: string): Promise<{ content: string }> {
  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, 1000))
  
  // Mock response
  return {
    content: `This is a mock response to: "${message}". Replace this with actual API integration.`
  }
}

export function useChat() {
  const { chatState, updateChatState } = useApp()

  const sendMessage = useCallback(async (content: string) => {
    const userMessageId = `user-${Date.now()}`
    const assistantMessageId = `assistant-${Date.now()}`

    // Add user message
    const userMessage: Message = {
      id: userMessageId,
      role: 'user',
      content,
      timestamp: new Date()
    }

    updateChatState({
      messages: [...chatState.messages, userMessage],
      isStreaming: true,
      streamingMessageId: assistantMessageId
    })

    try {
      // Call mock API (replace with real API)
      const response = await mockChatAPI(content)

      // Add assistant message
      const assistantMessage: Message = {
        id: assistantMessageId,
        role: 'assistant',
        content: response.content,
        timestamp: new Date()
      }

      updateChatState({
        messages: [...chatState.messages, userMessage, assistantMessage],
        isStreaming: false,
        streamingMessageId: null
      })
    } catch (error) {
      // Handle error
      const errorMessage: Message = {
        id: assistantMessageId,
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'An unknown error occurred'}`,
        timestamp: new Date()
      }

      updateChatState({
        messages: [...chatState.messages, userMessage, errorMessage],
        isStreaming: false,
        streamingMessageId: null
      })
    }
  }, [chatState.messages, updateChatState])

  const updateInput = useCallback((input: string) => {
    updateChatState({
      currentInput: input
    })
  }, [updateChatState])

  const clearMessages = useCallback(() => {
    updateChatState({
      messages: [],
      isStreaming: false,
      currentInput: '',
      streamingMessageId: null
    })
  }, [updateChatState])

  return {
    sendMessage,
    updateInput,
    clearMessages,
    messages: chatState.messages,
    isStreaming: chatState.isStreaming,
    currentInput: chatState.currentInput
  }
}