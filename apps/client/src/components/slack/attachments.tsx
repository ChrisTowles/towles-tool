import { useEffect, useState } from "react";
import { ImageOff, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import { isFileScopeError, slackDmFile, type DmFile } from "@/lib/slack";
import { openExternalUrl } from "@/lib/open-url";
import { isTauri } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";

/** A message's attached files: images inline, everything else as a named chip. */
export function Attachments({ files, hasText }: { files: DmFile[]; hasText: boolean }) {
  return (
    <div className={cn("flex flex-col gap-1.5", hasText && "mt-1.5")}>
      {files.map((file) =>
        file.isImage ? (
          <ImageAttachment key={file.id} file={file} />
        ) : (
          <FileChip key={file.id} file={file} />
        ),
      )}
    </div>
  );
}

function fileSrcUrl(file: DmFile): string {
  return file.thumbUrl || file.urlPrivate;
}

function openFile(file: DmFile) {
  uiAction("slack.open_file", "slack");
  void openExternalUrl(file.permalink || file.urlPrivate);
}

/** The private URL needs the bearer token, so the bytes come over IPC. Keyed on
 * the URL, not the `DmFile`: a refetch hands back equal-but-new objects, and
 * reloading would drop loaded images to a short placeholder and jolt the
 * thread's scroll as they came back. */
function ImageAttachment({ file }: { file: DmFile }) {
  const url = fileSrcUrl(file);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!isTauri()) {
      setSrc(url);
      return;
    }
    void slackDmFile(url).then((fetched) => {
      if (!alive) return;
      fetched.match({
        ok: ({ mimetype, dataBase64 }) => setSrc(`data:${mimetype};base64,${dataBase64}`),
        err: (e) => setError(e.message),
      });
    });
    return () => {
      alive = false;
    };
  }, [url]);

  if (error !== null) {
    const note = isFileScopeError(error)
      ? "image unavailable until Slack re-auth (files:read)"
      : "couldn't load image";
    return (
      <button
        type="button"
        onClick={() => openFile(file)}
        className="flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/60"
      >
        <ImageOff className="size-4 shrink-0" />
        <span className="truncate">
          {file.name} — {note}
        </span>
      </button>
    );
  }
  if (!src) {
    return <div className="h-40 w-56 max-w-full animate-pulse rounded-md bg-muted" />;
  }
  return (
    <button type="button" onClick={() => openFile(file)} className="block">
      <img
        src={src}
        alt={file.name}
        className="max-h-64 max-w-full rounded-md border border-border object-contain"
      />
    </button>
  );
}

function FileChip({ file }: { file: DmFile }) {
  return (
    <button
      type="button"
      onClick={() => openFile(file)}
      className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-left text-xs hover:bg-muted/50"
    >
      <Paperclip className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate font-medium text-foreground">{file.name}</span>
    </button>
  );
}
