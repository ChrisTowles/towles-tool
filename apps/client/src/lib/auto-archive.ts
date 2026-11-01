import { Schema } from "effect";
import { subscribe } from "@/lib/run";
import { list } from "@/lib/schemas/shape";
import { toast } from "@/lib/toast";

// Rust archives repos that have gone quiet (`agentboard.autoArchiveAfterHours`);
// this only says so, and holds the hours ⇄ "N days" round trip the setting shows.

export type ArchiveUnit = "hours" | "days";

/** What switching auto-archive on starts at: a week. */
export const DEFAULT_AUTO_ARCHIVE_HOURS = 7 * 24;

/** Stored hours as the UI shows them — days whenever they divide evenly, so 168
 * reads "7 days" and 36 stays "36 hours". */
export function splitArchiveHours(hours: number): { amount: number; unit: ArchiveUnit } {
  return hours % 24 === 0 ? { amount: hours / 24, unit: "days" } : { amount: hours, unit: "hours" };
}

export function archiveHours(amount: number, unit: ArchiveUnit): number {
  const n = Math.max(1, Math.floor(amount));
  return unit === "days" ? n * 24 : n;
}

const AutoArchivedSchema = Schema.Struct({ names: list(Schema.String) });

export function subscribeAutoArchived(): () => void {
  return subscribe(
    "agentboard://auto-archived",
    ({ names }) => {
      toast.info(
        names.length === 1 ? `Archived ${names[0]}` : `Archived ${names.length} idle repos`,
        {
          description: `Nothing happened in ${names.length === 1 ? "it" : "them"} for a while. Restore from Archived at the bottom of the rail.`,
        },
      );
    },
    AutoArchivedSchema,
  );
}
