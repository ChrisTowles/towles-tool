import { Result } from "effect";
import { useState } from "react";
import { ImageSquareIcon, PaperPlaneTiltIcon, SmileyIcon, XIcon } from "@phosphor-icons/react";
import { Button, InputArea } from "@cloudflare/kumo";
import { cn } from "@/lib/utils";
import {
  clipboardImageFromHost,
  imagesFromDataTransfer,
  isPasteableImage,
  type PastedImage,
} from "@/lib/pasted-images";
import { toast } from "@/lib/toast";
import { EmojiPicker } from "./emoji-picker";

/** The message composer. Enter sends, Shift+Enter breaks the line; the emoji
 * button inserts a `:shortcode:`, which is what Slack renders on receipt. With
 * `acceptImages`, a pasted image waits as a thumbnail and goes with the text. */
export function Composer({
  placeholder,
  sending,
  onSend,
  compact,
  acceptImages,
}: {
  placeholder: string;
  sending: boolean;
  onSend: (text: string, images: PastedImage[]) => Promise<boolean>;
  compact?: boolean;
  acceptImages?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<PastedImage[]>([]);

  async function send() {
    const text = draft.trim();
    if ((!text && images.length === 0) || sending) return;
    if (await onSend(text, images)) {
      setDraft("");
      setImages([]);
    }
  }

  function addImages(incoming: PastedImage[]) {
    setImages((prev) => {
      const seen = new Set(prev.map((i) => i.dataBase64));
      return [...prev, ...incoming.filter((i) => !seen.has(i.dataBase64))];
    });
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!acceptImages) return;
    const pasted = Array.from(e.clipboardData?.items ?? []).filter(
      (it) => it.kind === "file" && it.type.startsWith("image/"),
    );
    if (pasted.length) {
      e.preventDefault();
      if (!pasted.some((it) => isPasteableImage(it.type))) {
        toast.error(`Can't attach ${pasted[0].type} — paste a PNG, JPEG, GIF, or WebP.`);
        return;
      }
      void imagesFromDataTransfer(e.clipboardData).then((r) =>
        Result.match(r, { onSuccess: addImages, onFailure: (err) => toast.error(err.message) }),
      );
      return;
    }
    // `getData`, not `items` — that is what WebKitGTK populates.
    if (e.clipboardData?.getData("text")) return;
    // WebKitGTK delivers an image paste with empty `clipboardData`: ask the OS.
    e.preventDefault();
    void clipboardImageFromHost().then((img) => img && addImages([img]));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
    // WebKitGTK may fire no `paste` event for an image at all, so Ctrl+V asks
    // the OS too. No preventDefault: a text paste must still land natively.
    if (acceptImages && e.key.toLowerCase() === "v" && (e.metaKey || e.ctrlKey)) {
      void clipboardImageFromHost().then((img) => img && addImages([img]));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((img) => (
            <div key={img.id} className="relative">
              <img
                src={img.previewUrl}
                alt={img.name}
                className="size-14 rounded border border-kumo-hairline object-cover"
              />
              <button
                type="button"
                aria-label={`Remove ${img.name}`}
                title="Remove"
                onClick={() => setImages((prev) => prev.filter((i) => i.id !== img.id))}
                className="absolute -top-1.5 -right-1.5 rounded-full border border-kumo-hairline bg-kumo-base p-0.5 text-kumo-subtle hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        {acceptImages && (
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            aria-label="Attach the image on your clipboard"
            title="Attach the image on your clipboard (or paste with Ctrl+V)"
            className="h-9 text-kumo-subtle"
            icon={<ImageSquareIcon className="size-4" />}
            onClick={() =>
              void clipboardImageFromHost().then((img) =>
                img ? addImages([img]) : toast.error("No image on the clipboard — copy one first."),
              )
            }
          />
        )}
        <div className="relative flex-1">
          <InputArea
            aria-label={placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={placeholder}
            rows={1}
            className="max-h-40 min-h-9 resize-none pr-9"
          />
          <EmojiPicker
            align="end"
            onPick={(name) => setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}:${name}: `)}
            trigger={
              <button
                type="button"
                title="Insert emoji"
                className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded text-kumo-subtle hover:bg-kumo-recessed hover:text-kumo-default"
              >
                <SmileyIcon className="size-4" />
              </button>
            }
          />
        </div>
        <Button
          variant="primary"
          size={compact ? "sm" : "lg"}
          className={cn("bg-agent text-white hover:bg-agent/90", compact && "h-9")}
          icon={<PaperPlaneTiltIcon className="size-3.5" />}
          onClick={() => void send()}
          disabled={sending || (draft.trim().length === 0 && images.length === 0)}
        >
          {compact ? "Reply" : "Send"}
        </Button>
      </div>
    </div>
  );
}
