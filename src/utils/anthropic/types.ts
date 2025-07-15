import type {
  ContentBlock,
  ContentBlockParam,
  Message,
  MessageParam,

} from '@anthropic-ai/sdk/resources' // only used for types
import { z } from 'zod/v4'

// This file defines types and interfaces for Claude SDK messages and related structures.
// copied from https://github.com/tuanemuy/cc-jsonl/blob/main/src/core/domain/claude/types.ts
// which is also using the Anthropic claude-code package.

export const sendMessageInputSchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  bypassPermissions: z.boolean().optional(),
})
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>

export type AssistantContent = ContentBlock[]
export type UserContent = string | ContentBlockParam[]

export interface AssistantMessage {
  type: 'assistant'
  message: Message // From Anthropic SDK
  session_id: string
}

export function isAssistantMessage(
  message: SDKMessage,
): message is AssistantMessage {
  return message.type === 'assistant'
}

export interface UserMessage {
  type: 'user'
  message: MessageParam // Anthropic SDK
  session_id: string
}

export function isUserMessage(message: SDKMessage): message is UserMessage {
  return message.type === 'user'
}

export interface ResultMessage {
  type: 'result'
  subtype: 'success' | 'error_max_turns' | 'error_during_execution'
  duration_ms: number
  duration_api_ms: number
  is_error: boolean
  num_turns: number
  result?: string // Only on success
  session_id: string
  total_cost_usd: number
};

export function isResultMessage(message: SDKMessage): message is ResultMessage {
  return message.type === 'result'
}

export interface SystemMessage {
  type: 'system'
  subtype: 'init'
  apiKeySource: string
  cwd: string
  session_id: string
  tools: string[]
  mcp_servers: {
    name: string
    status: string
  }[]
  model: string
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
};

export function isSystemMessage(message: SDKMessage): message is SystemMessage {
  return message.type === 'system'
}

export type SDKMessage
  = | AssistantMessage
    | UserMessage
    | ResultMessage
    | SystemMessage

// ChunkData is simply an SDKMessage
// The SDK already provides messages in the appropriate granularity for streaming
export type ChunkData = SDKMessage

// Tool result type for handling tool execution results
export interface ToolResult {
  type: 'tool_result'
  tool_use_id: string
  content?: string | Record<string, unknown>[]
  is_error?: boolean
};

export function isToolResult(obj: unknown): obj is ToolResult {
  return (
    typeof obj === 'object'
    && obj !== null
    && 'type' in obj
    && obj.type === 'tool_result'
    && 'tool_use_id' in obj
    && typeof (obj as ToolResult).tool_use_id === 'string'
  )
}

// Helper function to safely parse SDKMessage
export function parseSDKMessage(data: unknown): SDKMessage | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }

  const obj = data as Record<string, unknown>

  if (typeof obj.type !== 'string') {
    return null
  }

  // Basic validation for different message types
  switch (obj.type) {
    case 'assistant':
      if (
        obj.message
        && typeof obj.message === 'object'
        && obj.message !== null
        && typeof obj.session_id === 'string'
      ) {
        return obj as unknown as AssistantMessage
      }
      break
    case 'user':
      if (
        obj.message
        && typeof obj.message === 'object'
        && obj.message !== null
        && typeof obj.session_id === 'string'
      ) {
        return obj as unknown as UserMessage
      }
      break
    case 'result':
      if (
        typeof obj.session_id === 'string'
        && typeof obj.subtype === 'string'
        && typeof obj.duration_ms === 'number'
        && typeof obj.is_error === 'boolean'
      ) {
        return obj as unknown as ResultMessage
      }
      break
    case 'system':
      if (
        typeof obj.session_id === 'string'
        && typeof obj.subtype === 'string'
        && typeof obj.cwd === 'string'
      ) {
        return obj as unknown as SystemMessage
      }
      break
  }

  return null
}
