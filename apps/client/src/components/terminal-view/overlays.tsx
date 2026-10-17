import { useState, type RefObject } from "react";
import { Button, Dialog, Input } from "@cloudflare/kumo";
import { CaretDownIcon, CaretUpIcon, XIcon } from "@phosphor-icons/react";
import type { TermLink } from "@/lib/term-links";
import { macKeymap } from "@/lib/keymap";
import { matchesShortcut } from "@/lib/shortcuts";
import { openExternalUrl } from "@/lib/open-url";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { IconBtn } from "@/components/agentboard-bits/primitives";
import type { TermBridge } from "@/components/terminal-view/search";

type PathLink = Extract<TermLink, { kind: "path" }>;

/** Right-click menu; items route through `bridgeRef`. `finalFocus` returns focus to the hidden input so typing/IME keep working. */
export function TermContextMenu({
  canvasRef,
  bridgeRef,
  onOpenPath,
  onRevealPath,
  openPathInEditor,
  revealPathExternally,
  onSearch,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  bridgeRef: RefObject<TermBridge | null>;
  onOpenPath?: (path: string, line: number | null) => void;
  onRevealPath?: (path: string) => void;
  openPathInEditor: (link: PathLink) => void;
  revealPathExternally: (link: PathLink) => void;
  onSearch: () => void;
}) {
  const [copyEnabled, setCopyEnabled] = useState(false);
  const [menuLink, setMenuLink] = useState<TermLink | null>(null);
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) setCopyEnabled(bridgeRef.current?.hasSelection() ?? false);
      }}
    >
      <ContextMenuTrigger
        render={
          <canvas
            ref={canvasRef}
            className="block"
            onContextMenu={(e) =>
              setMenuLink(
                bridgeRef.current?.linkAtPoint(e.nativeEvent.offsetX, e.nativeEvent.offsetY) ??
                  null,
              )
            }
          />
        }
      />
      <ContextMenuContent
        finalFocus={() => {
          bridgeRef.current?.focusTerm();
          return false;
        }}
      >
        {menuLink && (
          <>
            <ContextMenuItem
              onClick={() =>
                menuLink.kind === "url"
                  ? void openExternalUrl(menuLink.url)
                  : bridgeRef.current?.openPath(menuLink)
              }
            >
              {menuLink.kind === "url"
                ? "Open link"
                : onOpenPath
                  ? "Open in files"
                  : "Open in external editor"}
            </ContextMenuItem>
            {menuLink.kind === "path" && onOpenPath && (
              <ContextMenuItem onClick={() => openPathInEditor(menuLink)}>
                Open in external editor
              </ContextMenuItem>
            )}
            {menuLink.kind === "path" && (
              <>
                <ContextMenuSeparator />
                {onRevealPath && (
                  <ContextMenuItem onClick={() => onRevealPath(menuLink.path)}>
                    Open folder in files
                  </ContextMenuItem>
                )}
                <ContextMenuItem onClick={() => revealPathExternally(menuLink)}>
                  Open folder in file manager
                </ContextMenuItem>
              </>
            )}
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem disabled={!copyEnabled} onClick={() => bridgeRef.current?.copy()}>
          Copy
          <ContextMenuShortcut>{macKeymap() ? "⇧⌘C" : "Ctrl+Shift+C"}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!copyEnabled} onClick={() => bridgeRef.current?.copy(true)}>
          Copy as Markdown
        </ContextMenuItem>
        <ContextMenuItem onClick={() => bridgeRef.current?.paste()}>Paste</ContextMenuItem>
        <ContextMenuItem onClick={() => bridgeRef.current?.selectAll()}>Select all</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onSearch}>
          Search scrollback
          <ContextMenuShortcut>{macKeymap() ? "⇧⌘F" : "Ctrl+Shift+F"}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => bridgeRef.current?.clearScrollback()}>
          Clear scrollback
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Scrollback search overlay (Ctrl/⌘+Shift+F). Enter/Shift+Enter step through matches; Escape returns focus to the terminal. */
export function TermSearchBar({
  inputRef,
  query,
  onQuery,
  matchCount,
  currentMatch,
  step,
  onClose,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (query: string) => void;
  matchCount: number;
  currentMatch: number;
  step: (dir: 1 | -1) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute right-1 top-1 z-10 flex items-center gap-1 rounded-md border border-kumo-hairline bg-kumo-base p-1 shadow-md">
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape" || matchesShortcut("term-search", e.nativeEvent)) {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Search scrollback"
        size="xs"
        className="w-44 px-2 text-xs"
        spellCheck={false}
        aria-label="search scrollback"
      />
      <span className="min-w-10 text-center font-mono text-micro tabular-nums text-kumo-subtle">
        {matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : "0/0"}
      </span>
      <IconBtn title="Previous match (Shift+Enter)" onClick={() => step(-1)}>
        <CaretUpIcon className="size-3" />
      </IconBtn>
      <IconBtn title="Next match (Enter)" onClick={() => step(1)}>
        <CaretDownIcon className="size-3" />
      </IconBtn>
      <IconBtn title="Close search (Esc)" onClick={onClose}>
        <XIcon className="size-3" />
      </IconBtn>
    </div>
  );
}

/** Confirm a multi-line paste the engine held back: the shell has no bracketed paste, so every line would run the moment it lands. */
export function PastePrompt({
  pendingPaste,
  onCancel,
  onClosed,
  onConfirm,
}: {
  pendingPaste: string | null;
  onCancel: () => void;
  onClosed: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root
      role="alertdialog"
      open={pendingPaste !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) onClosed();
      }}
    >
      <Dialog size="lg" className="p-6">
        <Dialog.Title className="text-lg font-semibold">
          Paste {pendingPaste?.split("\n").length ?? 0} lines?
        </Dialog.Title>
        <Dialog.Description className="mt-2 text-sm text-kumo-subtle">
          This shell isn't guarding pastes (no bracketed paste), so each line runs as soon as it
          arrives — including the last one if it ends with a newline.
        </Dialog.Description>
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close
            render={(p) => (
              <Button {...p} variant="secondary">
                Cancel
              </Button>
            )}
          />
          <Button variant="primary" onClick={onConfirm}>
            Paste
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
