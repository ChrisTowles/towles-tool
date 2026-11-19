// How an application records observations for `everystate conform`: one JSON line per step of the
// model, written where the step happens, with the model's names and only the values this code knows.
import { appendFileSync } from 'node:fs';

const TRACE = process.env.CONFORM_TRACE; // unset in production: nothing is written

export function observe(action: string | null, state: Record<string, unknown>) {
  if (TRACE) appendFileSync(TRACE, JSON.stringify({ ts: Date.now(), action, state }) + '\n');
}

// At start-up:           observe(null, { sent: 0, charges: 0, confirmed: false });
// In the client's send:  observe('Send', { sent: attempts });
// In the server:         observe('Handle', { charges: await countCharges(key) });
// On the reply:          observe('Receive', { confirmed: true });
