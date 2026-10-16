import { invoke } from "@/lib/tauri";
import { RepeatedErrorListSchema, type RepeatedError } from "@/lib/schemas/doctor";

/** How often the app re-reads the last day's log for failures that keep recurring. */
const POLL_MS = 5 * 60_000;

/** The groups not toasted yet this session, most frequent first; marks them seen. A
 * failure that keeps recurring toasts once, not on every poll. */
export function takeNew(errors: readonly RepeatedError[], seen: Set<string>): RepeatedError[] {
  const fresh = errors.filter((e) => !seen.has(e.key));
  for (const e of fresh) seen.add(e.key);
  return fresh;
}

export function repeatTitle(e: RepeatedError): string {
  return `Failing over and over: ${e.message} (×${e.count} in 24h)`;
}

/** The error text, cut short — a toast isn't the place for a whole SQL statement. */
export function repeatDetail(e: RepeatedError, max = 160): string | undefined {
  if (!e.error) return undefined;
  return e.error.length > max ? `${e.error.slice(0, max)}…` : e.error;
}

/** Poll `doctor_repeated_errors` and hand each new group to `onNew`. Returns the stop. */
export function watchRepeatedErrors(onNew: (e: RepeatedError) => void): () => void {
  const seen = new Set<string>();
  const poll = async () => {
    const result = await invoke<RepeatedError[]>(
      "doctor_repeated_errors",
      {},
      { schema: RepeatedErrorListSchema },
    );
    takeNew(result.unwrapOr([]), seen).forEach(onNew);
  };
  const first = setTimeout(() => void poll(), 60_000);
  const every = setInterval(() => void poll(), POLL_MS);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
