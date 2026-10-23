/** What the band shows: this checkout's board task and the next meeting, as the app reports them. */
export type BandTask = {
  id: number
  text: string
  status: string
  pr: { number: number; state: string; checks: string } | null
}

export type BandMeeting = { id: number; title: string; minutesUntil: number; live: boolean }

export type Snapshot = { task: BandTask | null; meeting: BandMeeting | null }

/** A PR's check state as last seen, so a change raises one toast. */
export type SeenChecks = { pr: number; checks: string }

/** A note the user sent this session from the app, as `inbox_take` hands it over. */
export type InboxNote = { id: number; body: string; images: string[] }

/** The last finished turn, as `/next` asks about it. */
export type TurnLog = { tools: string[]; commands: string[]; answer: string }

declare module 'claude-code' {
  interface PluginState {
    'towles-tool-app': {
      snapshot: Snapshot | null
      /** The meeting the five-minute toast already fired for, so it fires once. */
      warnedMeeting: number | null
      seenChecks: SeenChecks | null
      /** Notes already handed to the model, newest last. */
      seenNotes: number[]
      lastTurn: TurnLog | null
      /** What `/next` proposed, until a prompt is sent. */
      suggestion: string | null
      asking: boolean
    }
  }
}
