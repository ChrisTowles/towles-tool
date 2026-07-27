import { useState } from "react";

/**
 * Copy to the clipboard, with a short-lived "copied" acknowledgement.
 *
 * Keyed rather than boolean so one hook can serve a row of copy buttons — the
 * key identifies *which* one was pressed, and the reset only clears that key,
 * so a second copy mid-flight can't cancel the first's feedback.
 *
 * The acknowledgement is the button changing, deliberately not a toast: copying
 * is a low-stakes action the user just initiated, and a toast per copy is noise
 * in a list where copying several things in a row is the normal flow.
 */
/** Long enough to read the checkmark, short enough that the button is back to
 * its normal self before you look again. */
const RESET_MS = 1200;

export function useClipboardCopy() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  function copy(key: string, text: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), RESET_MS);
    });
  }

  return { copiedKey, copy };
}
