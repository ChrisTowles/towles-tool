import { useEffect } from "react";
import { Button, Dialog } from "@cloudflare/kumo";
import { CaretLeftIcon, CaretRightIcon, XIcon } from "@phosphor-icons/react";

/** The subset of a `PastedImage` (`lib/agentboard.ts`) the viewer needs: a
 * stable id, a name to caption it with, and the bytes as a `data:` URL. */
export type LightboxImage = {
  id: string;
  name: string;
  previewUrl: string;
};

/** Index of `openId` in `images`, or `-1`. */
export function lightboxIndex(images: readonly LightboxImage[], openId: string | null): number {
  return openId === null ? -1 : images.findIndex((img) => img.id === openId);
}

/** The id `delta` steps away from `openId`, wrapping at both ends. `null` when
 * the current id isn't in the list (it was detached while zoomed). */
export function lightboxStep(
  images: readonly LightboxImage[],
  openId: string | null,
  delta: number,
): string | null {
  const index = lightboxIndex(images, openId);
  if (index < 0 || images.length === 0) return null;
  return images[(index + delta + images.length) % images.length].id;
}

/** Full-size viewer for attached images. Controlled by id rather than index, so
 * removing an image while the viewer is open closes it instead of silently
 * zooming a different one. */
export function ImageLightbox({
  images,
  openId,
  onOpenChange,
}: {
  images: readonly LightboxImage[];
  openId: string | null;
  onOpenChange: (id: string | null) => void;
}) {
  const index = lightboxIndex(images, openId);
  const image = index < 0 ? null : images[index];
  const step = (delta: number) => onOpenChange(lightboxStep(images, openId, delta));
  const isOpen = image !== null;

  useEffect(() => {
    if (!isOpen || images.length < 2) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onOpenChange(lightboxStep(images, openId, -1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onOpenChange(lightboxStep(images, openId, 1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, images, openId, onOpenChange]);

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onOpenChange(null)}>
      <Dialog className="flex w-auto max-w-[min(92vw,72rem)] flex-col gap-3 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Dialog.Title className="truncate text-lg font-semibold">
              {image?.name ?? ""}
            </Dialog.Title>
            <Dialog.Description className="text-sm text-kumo-subtle">
              {images.length > 1
                ? `${index + 1} of ${images.length} — ← → to move, Esc to close`
                : "Esc to close"}
            </Dialog.Description>
          </div>
          <Dialog.Close
            aria-label="Close"
            render={(p) => (
              <Button
                {...p}
                variant="ghost"
                shape="square"
                size="sm"
                aria-label="Close"
                icon={<XIcon className="size-4" />}
              />
            )}
          />
        </div>
        <div className="flex items-center gap-2">
          {images.length > 1 && (
            <button
              type="button"
              aria-label="Previous image"
              onClick={() => step(-1)}
              className="rounded border border-kumo-hairline p-1 text-kumo-subtle hover:text-kumo-default"
            >
              <CaretLeftIcon className="size-4" />
            </button>
          )}
          {image && (
            <img
              src={image.previewUrl}
              alt={image.name}
              className="max-h-[75vh] min-w-0 rounded border border-kumo-hairline object-contain"
            />
          )}
          {images.length > 1 && (
            <button
              type="button"
              aria-label="Next image"
              onClick={() => step(1)}
              className="rounded border border-kumo-hairline p-1 text-kumo-subtle hover:text-kumo-default"
            >
              <CaretRightIcon className="size-4" />
            </button>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
