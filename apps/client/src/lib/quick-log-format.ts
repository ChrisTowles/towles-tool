/** ⌘J quick-log formatting — pure and clock-free, so the caller injects `now`.
 * `- HH:MM [context] text` matches `tt journal jot`'s bullet exactly, so app and
 * CLI captures interleave in one local-time daily note. */

export type FormatLogOpts = {
  now: Date | number;
  context?: string;
};

export function formatLogLine(text: string, opts: FormatLogOpts): string {
  const when = typeof opts.now === "number" ? new Date(opts.now) : opts.now;
  const hh = String(when.getHours()).padStart(2, "0");
  const mm = String(when.getMinutes()).padStart(2, "0");
  const body = text.trim();
  const context = opts.context?.trim();
  const prefix = context ? `[${context}] ` : "";
  return `- ${hh}:${mm} ${prefix}${body}`;
}

export type QuickLogKind = "journal" | "todo";

export type ParsedQuickLog = {
  kind: QuickLogKind;
  body: string;
};

const TODO_PREFIXES = ["/todo", "/t"];

export function parseQuickLog(text: string): ParsedQuickLog {
  const trimmed = text.trim();
  for (const prefix of TODO_PREFIXES) {
    if (trimmed.toLowerCase() === prefix) {
      return { kind: "todo", body: "" };
    }
    if (trimmed.slice(0, prefix.length).toLowerCase() === prefix) {
      const rest = trimmed.slice(prefix.length);
      if (/^\s/.test(rest)) {
        return { kind: "todo", body: rest.trim() };
      }
    }
  }
  return { kind: "journal", body: trimmed };
}
