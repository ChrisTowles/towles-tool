/** The `! <command>`s a finished turn offers to copy, each with its bang. */
export type Clips = string[]

declare module 'claude-code' {
  interface PluginState {
    tt: {
      /** What the last turn offered; cleared when the next turn starts. */
      clips: Clips
    }
  }
}
