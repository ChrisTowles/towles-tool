import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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

  return (
    <Dialog open={image !== null} onOpenChange={(open) => !open && onOpenChange(null)}>
      <DialogContent
        className="w-auto gap-3 sm:max-w-[min(92vw,72rem)]"
        onKeyDown={(e) => {
          if (images.length < 2) return;
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            step(-1);
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            step(1);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{image?.name ?? ""}</DialogTitle>
          <DialogDescription>
            {images.length > 1
              ? `${index + 1} of ${images.length} — ← → to move, Esc to close`
              : "Esc to close"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          {images.length > 1 && (
            <button
              type="button"
              aria-label="Previous image"
              onClick={() => step(-1)}
              className="rounded border border-border p-1 text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
            </button>
          )}
          {image && (
            <img
              src={image.previewUrl}
              alt={image.name}
              className="max-h-[75vh] min-w-0 rounded border border-border object-contain"
            />
          )}
          {images.length > 1 && (
            <button
              type="button"
              aria-label="Next image"
              onClick={() => step(1)}
              className="rounded border border-border p-1 text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className="size-4" />
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
