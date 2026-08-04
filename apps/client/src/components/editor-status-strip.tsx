import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { uiAction } from "@/lib/ui-action";

type Editor = import("monaco-editor").editor.IStandaloneCodeEditor;

type Strip = {
  line: number;
  column: number;
  language: string;
  insertSpaces: boolean;
  tabSize: number;
  eol: "LF" | "CRLF";
};

function readStrip(editor: Editor): Strip | null {
  const model = editor.getModel();
  if (!model || model.isDisposed()) return null;
  const pos = editor.getPosition();
  const opts = model.getOptions();
  return {
    line: pos?.lineNumber ?? 1,
    column: pos?.column ?? 1,
    language: model.getLanguageId(),
    insertSpaces: opts.insertSpaces,
    tabSize: opts.tabSize,
    eol: model.getEOL() === "\n" ? "LF" : "CRLF",
  };
}

const INDENTS: { label: string; insertSpaces: boolean; tabSize: number }[] = [
  { label: "Spaces: 2", insertSpaces: true, tabSize: 2 },
  { label: "Spaces: 4", insertSpaces: true, tabSize: 4 },
  { label: "Spaces: 8", insertSpaces: true, tabSize: 8 },
  { label: "Tabs", insertSpaces: false, tabSize: 4 },
];

/** VS Code's status-bar facts for one editor: cursor, indent (click to
 * change — writes the model's options, so typing and formatting follow),
 * language, EOL. Subscribes to the editor it's handed; the pane remounts it
 * with the editor, so no model-swap handling. */
export function EditorStatusStrip({ editor }: { editor: Editor }) {
  const [strip, setStrip] = useState<Strip | null>(() => readStrip(editor));
  useEffect(() => {
    const refresh = () => setStrip(readStrip(editor));
    refresh();
    const subs = [
      editor.onDidChangeCursorPosition(refresh),
      editor.onDidChangeModelOptions(refresh),
      editor.onDidChangeModelLanguage(refresh),
    ];
    return () => subs.forEach((s) => s.dispose());
  }, [editor]);
  if (!strip) return null;
  const indentLabel = strip.insertSpaces ? `Spaces: ${strip.tabSize}` : `Tabs: ${strip.tabSize}`;
  return (
    <div className="flex shrink-0 items-center justify-end gap-3 border-t bg-card px-2.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
      <span className="tabular-nums">
        Ln {strip.line}, Col {strip.column}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger className="rounded-sm px-1 hover:bg-accent hover:text-foreground">
          {indentLabel}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto">
          {INDENTS.map((indent) => (
            <DropdownMenuItem
              key={indent.label}
              onSelect={() => {
                editor
                  .getModel()
                  ?.updateOptions({ insertSpaces: indent.insertSpaces, tabSize: indent.tabSize });
                uiAction("editor.indent", "agentboard", indent.label);
              }}
            >
              {indent.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <span>{strip.language}</span>
      <span>{strip.eol}</span>
    </div>
  );
}
