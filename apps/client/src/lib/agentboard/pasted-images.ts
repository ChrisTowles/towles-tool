import { Result } from "better-result";
import { ImageTooLarge } from "@/lib/errors";
import { invoke } from "@/lib/tauri";

const PASTEABLE_IMAGE_MIMES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];

export function isPasteableImage(mime: string): boolean {
  return PASTEABLE_IMAGE_MIMES.includes(mime.split(";")[0].trim().toLowerCase());
}

const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024;

export type PastedImage = {
  id: string;
  name: string;
  mime: string;
  dataBase64: string;
  previewUrl: string;
};

/** Pull every image off a paste/drop's `DataTransfer`, decoded to base64. */
export async function imagesFromDataTransfer(
  data: DataTransfer | null,
): Promise<Result<PastedImage[], ImageTooLarge>> {
  const files = Array.from(data?.items ?? [])
    .filter((it) => it.kind === "file" && isPasteableImage(it.type))
    .map((it) => it.getAsFile())
    .filter((f): f is File => f != null);
  const tooBig = files.find((f) => f.size > MAX_PASTED_IMAGE_BYTES);
  if (tooBig) {
    return Result.err(
      new ImageTooLarge({
        name: tooBig.name || "that image",
        bytes: tooBig.size,
        limitBytes: MAX_PASTED_IMAGE_BYTES,
      }),
    );
  }
  return Result.ok(await Promise.all(files.map((file, i) => readImageFile(file, i))));
}

export async function clipboardImageFromHost(): Promise<PastedImage | null> {
  const result = await invoke<{ mime: string; dataBase64: string } | null>("read_clipboard_image");
  const image = result.unwrapOr(null);
  if (!image) return null;
  return {
    id: `clipboard-${image.dataBase64.length}`,
    name: "clipboard image",
    mime: image.mime,
    dataBase64: image.dataBase64,
    previewUrl: `data:${image.mime};base64,${image.dataBase64}`,
  };
}

async function readImageFile(file: File, index: number): Promise<PastedImage> {
  const previewUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("couldn't read the pasted image")),
    );
    reader.readAsDataURL(file);
  });
  return {
    // Clipboard images are always `image.png`; the index keeps React keys apart.
    id: `${file.name || "pasted"}-${index}-${previewUrl.length}-${file.size}`,
    name: file.name || `pasted-image-${index + 1}`,
    mime: file.type,
    dataBase64: previewUrl.slice(previewUrl.indexOf(",") + 1),
    previewUrl,
  };
}
