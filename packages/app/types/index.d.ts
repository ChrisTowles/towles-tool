/** What the band shows: this checkout's board task and the next meeting, as the app reports them. */
export type BandTask = {
  id: number
  text: string
  status: string
  pr: { number: number; state: string; checks: string } | null
}

export type BandMeeting = { id: number; title: string; minutesUntil: number; live: boolean }

export type Snapshot = { task: BandTask | null; meeting: BandMeeting | null }

declare module 'claude-code' {
  interface PluginState {
    'towles-tool-app': {
      snapshot: Snapshot | null
      /** The meeting the five-minute toast already fired for, so it fires once. */
      warnedMeeting: number | null
    }
  }
}
