import { createContext, useContext } from "react";
import { toast } from "@/lib/toast";
import { NEUTRAL, PALETTE } from "@/lib/colors";
import { repoInk } from "@/lib/repo-identity";
import { NotInTauri, type IpcError } from "@/lib/errors";

/** Surface a failed sessions read. Silent outside the Tauri shell, where every
 * command fails identically and the screen already says so. */
export function reportSessionsError(error: IpcError) {
  if (!NotInTauri.is(error)) toast.error(error.message);
}

/** The 8 common tools get dedicated hues; anything else folds to gray so the legend stays honest. */
const TOOL_COLORS: Record<string, string> = {
  Glob: PALETTE[0],
  Read: PALETTE[1],
  Task: PALETTE[3],
  Grep: PALETTE[4],
  Edit: PALETTE[5],
  MultiEdit: PALETTE[5],
  Bash: PALETTE[6],
  Write: PALETTE[7],
};

export function toolColor(name: string | null | undefined): string {
  if (!name) return NEUTRAL;
  return TOOL_COLORS[name] ?? (name.startsWith("mcp") ? PALETTE[2] : NEUTRAL);
}

/** A Claude Sessions project, in its repo's color — the same one the rail and
 * the charts give it. */
export function ProjectName({ name, className }: { name: string; className?: string }) {
  const colors = useContext(ProjectColorsContext);
  const hex = colors.get(name);
  return (
    <span className={className} style={hex ? { color: repoInk(hex) } : undefined}>
      {name}
    </span>
  );
}

export const ProjectColorsContext = createContext<Map<string, string>>(new Map());
