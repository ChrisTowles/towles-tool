/**
 * Minimal task interface - only needs output property
 */
interface TaskWithOutput {
    output: string
}

/**
 * Handler for streaming Claude output into Listr2 tasks.
 * Updates the task output with each delta received from the Claude CLI.
 */
export class ListrStreamHandler {
    private task: TaskWithOutput
    private buffer: string = ''
    private maxTitleLength: number

    constructor(
        task: TaskWithOutput,
        maxTitleLength = 80,
    ) {
        this.task = task
        this.maxTitleLength = maxTitleLength
    }

    /**
     * Truncate text to maxLength chars with ellipsis suffix.
     */
    private truncateTitle(text: string): string {
        if (text.length <= this.maxTitleLength) return text
        return text.substring(0, this.maxTitleLength - 3) + '...'
    }

    /**
     * Add a streaming delta to the task output.
     * The output replaces the previous line, showing the most recent text.
     */
    addDelta(text: string): void {
        if (!text) return

        // Append to buffer
        this.buffer += text

        // Get last line for display (most recent activity)
        const lines = this.buffer.split('\n').filter(l => l.trim())
        const lastLine = lines[lines.length - 1] || ''

        // Update task output with truncated last line
        this.task.output = this.truncateTitle(lastLine)
    }

    /**
     * Get the full accumulated output.
     */
    getOutput(): string {
        return this.buffer
    }

    /**
     * Clear the buffer.
     */
    clear(): void {
        this.buffer = ''
        this.task.output = ''
    }
}
