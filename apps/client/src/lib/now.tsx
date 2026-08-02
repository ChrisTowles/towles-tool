import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** A single app-wide wall clock: one `setInterval` feeds every countdown and
 * escalation timer. A consumer needing finer resolution than 15s asks via
 * {@link useNowInterval}; the provider ticks at the fastest live request. */
const DEFAULT_TICK_MS = 15_000;

type NowValue = {
  now: number;
  /** Register a requested tick interval; returns an unregister fn. */
  requestInterval: (ms: number) => () => void;
};

const NowContext = createContext<NowValue | null>(null);

export function NowProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  const [tickMs, setTickMs] = useState(DEFAULT_TICK_MS);
  const requests = useRef<number[]>([]);

  const requestInterval = useCallback((ms: number) => {
    requests.current.push(ms);
    setTickMs(Math.min(...requests.current, DEFAULT_TICK_MS));
    return () => {
      const i = requests.current.indexOf(ms);
      if (i !== -1) requests.current.splice(i, 1);
      setTickMs(Math.min(...requests.current, DEFAULT_TICK_MS));
    };
  }, []);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);

  const value = useMemo<NowValue>(() => ({ now, requestInterval }), [now, requestInterval]);
  return <NowContext.Provider value={value}>{children}</NowContext.Provider>;
}

function useNowContext(): NowValue {
  const ctx = useContext(NowContext);
  if (ctx === null) {
    throw new Error("useNow must be used within a NowProvider");
  }
  return ctx;
}

/** Current wall-clock time (epoch ms), shared across the app. Must be used
 * under a {@link NowProvider}. */
export function useNow(): number {
  return useNowContext().now;
}

/** Ask the shared clock to tick at least this fast while mounted (`undefined`
 * requests nothing). Drops back to the default when the last requester
 * unmounts. */
export function useNowInterval(intervalMs: number | undefined): void {
  const { requestInterval } = useNowContext();
  useEffect(() => {
    if (intervalMs === undefined) return;
    return requestInterval(intervalMs);
  }, [intervalMs, requestInterval]);
}
