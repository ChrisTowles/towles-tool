/**
 * Minimal task interface - only needs output property
 */
interface TaskWithOutput {
    output: string
}

/**
 * Handler for streaming Claude output into Listr2 tasks.
 * Shows tools and text as separate output lines.
 */
export class ListrStreamHandler {
    private task: TaskWithOutput
    private buffer: string = ''
    private outputLines: string[] = []
    private maxLineLength: number
    private maxLines: number

    constructor(
        task: TaskWithOutput,
        maxLineLength = 80,
        maxLines = 8,
    ) {
        this.task = task
        this.maxLineLength = maxLineLength
        this.maxLines = maxLines
    }

    private truncate(text: string): string {
        if (text.length <= this.maxLineLength) return text
        return text.substring(0, this.maxLineLength - 3) + '...'
    }

    private updateOutput(): void {
        // Show last N lines
        const visible = this.outputLines.slice(-this.maxLines)
        this.task.output = visible.join('\n')
    }

    /**
     * Add a tool use event to output.
     */
    addTool(toolName: string, summary: string): void {
        const line = `⚡ ${toolName}: ${this.truncate(summary)}`
        this.outputLines.push(line)
        this.updateOutput()
    }

    /**
     * Add text output (appends to buffer, shows last line).
     */
    addText(text: string): void {
        if (!text) return
        this.buffer += text

        // Update last text line in output
        const lines = this.buffer.split('\n').filter(l => l.trim())
        if (lines.length > 0) {
            const lastLine = this.truncate(lines[lines.length - 1])
            // Find and update or add text line
            const textIdx = this.outputLines.findIndex(l => !l.startsWith('⚡'))
            if (textIdx >= 0) {
                this.outputLines[textIdx] = lastLine
            } else {
                this.outputLines.push(lastLine)
            }
            this.updateOutput()
        }
    }

    getOutput(): string {
        return this.buffer
    }

    clear(): void {
        this.buffer = ''
        this.outputLines = []
        this.task.output = ''
    }
}
