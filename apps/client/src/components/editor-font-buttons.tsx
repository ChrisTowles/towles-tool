import { AArrowDown, AArrowUp } from "lucide-react";
import { IconBtn } from "@/components/agentboard-bits";
import {
  clampEditorFontSize,
  MAX_EDITOR_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
  useEditorFontSize,
} from "@/lib/editor-prefs";
import { uiAction } from "@/lib/ui-action";

export function EditorFontButtons() {
  const [fontSize, setFontSize] = useEditorFontSize();
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {(
        [
          { delta: -1, icon: AArrowDown, label: "Smaller", at: fontSize <= MIN_EDITOR_FONT_SIZE },
          { delta: 1, icon: AArrowUp, label: "Larger", at: fontSize >= MAX_EDITOR_FONT_SIZE },
        ] as const
      ).map(({ delta, icon: Icon, label, at }) => (
        <IconBtn
          key={label}
          title={`${label} text — ${fontSize}px now (Ctrl/⌘ ${delta > 0 ? "+" : "−"} in the editor, Ctrl/⌘ 0 resets)`}
          disabled={at}
          onClick={() => {
            const next = clampEditorFontSize(fontSize + delta);
            setFontSize(next);
            uiAction("editor.font_size", "agentboard", String(next));
          }}
        >
          <Icon className="size-3.5" />
        </IconBtn>
      ))}
    </span>
  );
}
