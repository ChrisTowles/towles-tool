import { Schema } from "effect";
import { subscribe } from "@/lib/run";
import { toast } from "@/lib/toast";

// Rust closes a landed, idle task on its own; this only says so.

const AutoClosedSchema = Schema.Struct({ title: Schema.String, folderDir: Schema.String });

export function subscribeAutoClosed(): () => void {
  return subscribe(
    "task://auto-closed",
    ({ title }) => {
      toast.success(`Closed “${title}”`, {
        description: "Its work landed, so the task closed as done.",
      });
    },
    AutoClosedSchema,
  );
}
