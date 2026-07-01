/**
 * Shared scaffolding for the session pollers (git stats, ports): every
 * `intervalMs`, when sessions exist and a client is connected, run `tick` and
 * broadcast if it reports a change. Ticks never overlap; the initial tick
 * runs immediately and is not gated on clients so the first broadcast has
 * data.
 */
export function startSessionPoll<S>(opts: {
  intervalMs: number;
  getSessions: () => S[] | null;
  getClientCount: () => number;
  broadcastState: () => void;
  /** Returns whether anything changed and a broadcast is needed. */
  tick: (sessions: S[]) => boolean | Promise<boolean>;
}): ReturnType<typeof setInterval> {
  let running = false;
  const run = async (requireClients: boolean) => {
    if (running) return;
    running = true;
    try {
      const sessions = opts.getSessions();
      if (!sessions || (requireClients && opts.getClientCount() === 0)) return;
      if (await opts.tick(sessions)) opts.broadcastState();
    } finally {
      running = false;
    }
  };
  void run(false);
  return setInterval(() => void run(true), opts.intervalMs);
}
