import { useState } from "react";

/**
 * Keyed rather than boolean, so one hook serves a row of copy buttons and a
 * second copy mid-flight can't cancel the first's feedback.
 */
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
