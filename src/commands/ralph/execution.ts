import type { WriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import pc from 'picocolors'
import { x } from 'tinyexec'
import { CLAUDE_DEFAULT_ARGS } from './state'

// ============================================================================
// Types
// ============================================================================

interface StreamEvent {
    type: string
    event?: {
        type: string
        delta?: { text?: string }
    }
    // New format: assistant message
    message?: {
        content?: Array<{ type: string; text?: string }>
        usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
        }
    }
    result?: string
    total_cost_usd?: number
    num_turns?: number
    session_id?: string
    usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
    }
}

// Claude model context windows (tokens)
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
    'claude-sonnet-4-20250514': 200000,
    'claude-opus-4-20250514': 200000,
    'claude-3-5-sonnet-20241022': 200000,
    'claude-3-opus-20240229': 200000,
    'default': 200000,
}

export interface IterationResult {
    output: string
    exitCode: number
    contextUsedPercent?: number
    sessionId?: string
}

interface ParsedLine {
    text: string | null
    usage?: StreamEvent['usage']
    sessionId?: string
}

// ============================================================================
// Claude CLI Check
// ============================================================================

export async function checkClaudeCli(): Promise<boolean> {
    try {
        const result = await x('which', ['claude'])
        return result.exitCode === 0
    }
    catch {
        return false
    }
}

// ============================================================================
// Stream Parsing
// ============================================================================

function parseStreamLine(line: string): ParsedLine {
    if (!line.trim()) return { text: null }
    try {
        const data = JSON.parse(line) as StreamEvent
        // Extract text from streaming deltas (legacy format)
        if (data.type === 'stream_event' && data.event?.type === 'content_block_delta') {
            return { text: data.event.delta?.text || null }
        }
        // Add newline after content block ends (legacy format)
        if (data.type === 'stream_event' && data.event?.type === 'content_block_stop') {
            return { text: '\n' }
        }
        // NEW FORMAT: Handle assistant messages with content array
        if (data.type === 'assistant' && data.message) {
            // Extract text from content blocks
            const texts = data.message.content
                ?.filter(c => c.type === 'text' && c.text)
                .map(c => c.text)
                .join('') || null
            return { text: texts, usage: data.message.usage || data.usage, sessionId: data.session_id }
        }
        // Capture final result with usage and session_id
        if (data.type === 'result') {
            const resultText = data.result
                ? `\n[Result: ${data.result.substring(0, 100)}${data.result.length > 100 ? '...' : ''}]\n`
                : null
            return { text: resultText, usage: data.usage, sessionId: data.session_id }
        }
    } catch {
        // Not JSON, return raw
        return { text: line }
    }
    return { text: null }
}

// ============================================================================
// Run Iteration
// ============================================================================

export async function runIteration(
    prompt: string,
    claudeArgs: string[],
    logStream?: WriteStream,
): Promise<IterationResult> {
    // Pass task context as system prompt via --append-system-prompt
    // 'continue' is the user prompt - required by claude CLI when using --print
    const allArgs = [...CLAUDE_DEFAULT_ARGS, ...claudeArgs, '--append-system-prompt', prompt, 'continue']

    let output = ''
    let lineBuffer = ''
    let finalUsage: StreamEvent['usage'] | undefined
    let sessionId: string | undefined

    return new Promise((resolve) => {
        const proc = spawn('claude', allArgs, {
            stdio: ['inherit', 'pipe', 'pipe'],
        })

        proc.stdout.on('data', (chunk: Buffer) => {
            const text = chunk.toString()
            lineBuffer += text

            // Process complete lines
            const lines = lineBuffer.split('\n')
            lineBuffer = lines.pop() || '' // Keep incomplete line in buffer

            for (const line of lines) {
                const { text: parsed, usage, sessionId: sid } = parseStreamLine(line)
                if (usage) finalUsage = usage
                if (sid) sessionId = sid
                if (parsed) {
                    process.stdout.write(parsed)
                    logStream?.write(parsed)
                    output += parsed
                }
            }
        })

        proc.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString()
            process.stderr.write(text)
            logStream?.write(text)
            output += text
        })

        proc.on('close', (code: number | null) => {
            // Process any remaining buffer
            if (lineBuffer) {
                const { text: parsed, usage, sessionId: sid } = parseStreamLine(lineBuffer)
                if (usage) finalUsage = usage
                if (sid) sessionId = sid
                if (parsed) {
                    process.stdout.write(parsed)
                    logStream?.write(parsed)
                    output += parsed
                }
            }

            // Ensure output ends with newline for clean terminal display
            if (output && !output.endsWith('\n')) {
                process.stdout.write('\n')
                logStream?.write('\n')
                output += '\n'
            }

            // Calculate context usage percent
            let contextUsedPercent: number | undefined
            if (finalUsage) {
                const totalTokens = (finalUsage.input_tokens || 0)
                    + (finalUsage.output_tokens || 0)
                    + (finalUsage.cache_read_input_tokens || 0)
                    + (finalUsage.cache_creation_input_tokens || 0)
                const maxContext = MODEL_CONTEXT_WINDOWS.default
                contextUsedPercent = Math.round((totalTokens / maxContext) * 100)
            }

            resolve({ output, exitCode: code ?? 0, contextUsedPercent, sessionId })
        })

        proc.on('error', (err: Error) => {
            console.error(pc.red(`Error running claude: ${err}`))
            logStream?.write(`Error running claude: ${err}\n`)
            resolve({ output, exitCode: 1 })
        })
    })
}
