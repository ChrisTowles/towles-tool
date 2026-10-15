import type { TurnLog } from '../types'

const TOOLS_MAX = 40
const COMMANDS_MAX = 20
const COMMAND_CHARS = 200
const ANSWER_CHARS = 2000

export const emptyLog = (): TurnLog => ({ tools: [], commands: [], answer: '' })

/** One tool call the model made this turn, as the suggestion question reads it. */
export function logTool(log: TurnLog, tool: string, command: unknown): TurnLog {
  const tools = log.tools.length < TOOLS_MAX ? [...log.tools, tool] : log.tools
  const commands =
    tool === 'Bash' && typeof command === 'string' && log.commands.length < COMMANDS_MAX
      ? [...log.commands, command.slice(0, COMMAND_CHARS)]
      : log.commands
  return { ...log, tools, commands }
}

export function withAnswer(log: TurnLog, answer: string): TurnLog {
  return { ...log, answer: answer.slice(-ANSWER_CHARS) }
}

/** Whether the prompt sent was the suggestion: as shown, edited first, or not at all. */
export function taken(sent: string, suggestion: string | null): 'as-is' | 'edited' | null {
  if (!suggestion) return null
  const a = sent.trim()
  const b = suggestion.trim()
  if (a === b) return 'as-is'
  const head = b.slice(0, Math.min(20, b.length))
  return head.length >= 8 && a.startsWith(head) ? 'edited' : null
}
