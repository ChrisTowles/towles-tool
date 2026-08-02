import { useEffect, useState } from "react";
import { AppWindow, ExternalLink, FileCode2, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import { IconBtn, PanePlaceholder } from "@/components/agentboard-bits";
import { AnnotateSurface } from "@/components/annotate-surface";
import { PaneChrome, PaneLens } from "@/components/pane-chrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FolderData } from "@/lib/agentboard";
import { errorMessage } from "@/lib/errors";
import { launchConfigs } from "@/lib/launch";
import { openExternalUrl } from "@/lib/open-url";
import { PreviewDocView } from "@/components/preview-doc";
import {
  fileUrl,
  onPreviewFileChanged,
  type PreviewDoc,
  type PreviewRequest,
  previewReadFile,
  previewUnwatchFile,
  previewWatchFile,
  typedPreviewRequest,
} from "@/lib/preview-artifact";
import { type DevServer, devServersOf, previewCapture } from "@/lib/preview";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

/** A task's dev server or a file its agent pushed with `preview_file`, on one
 * surface, so you can circle the agent's own plan and reply to it. */
export function PreviewPane({
  folder,
  focused,
  file: pushed,
  onClose,
}: {
  /** Undefined when the checkout left the rail. */
  folder: FolderData | undefined;
  /** See the focus-ring rule in `screens/agentboard.tsx`'s `focusedPaneId`. */
  focused: boolean;
  /** `nonce` changes per `preview_file` call, so a rewrite re-reads. */
  file?: PreviewRequest;
  onClose: () => void;
}) {
  const dir = folder?.dir;

  const [url, setUrl] = useState("");
  const [input, setInput] = useState("");
  const [frameKey, setFrameKey] = useState(0);
  const [servers, setServers] = useState<DevServer[]>([]);

  // Two flags rather than a union: the dev server's URL must survive a look at
  // a file, so going back is a click, not a re-probe.
  const [doc, setDoc] = useState<PreviewDoc | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [showing, setShowing] = useState<"server" | "file">("server");
  // A typed path wins until the agent pushes a *new* one — a push must land.
  const [typed, setTyped] = useState<PreviewRequest | null>(null);
  const [pathInput, setPathInput] = useState("");
  const file = typed ?? pushed;

  // A timer per pane, because launch.json and port status aren't in the
  // agentboard snapshot. Put them there and this goes.
  useEffect(() => {
    if (!dir) return;
    let cancelled = false;
    const probe = async () => {
      const res = await launchConfigs(dir);
      if (cancelled) return;
      const found = res.isOk() ? devServersOf(folder?.name ?? "", dir, res.value) : [];
      setServers(found);
      setUrl((cur) => {
        if (cur) return cur;
        const auto = found.find((s) => s.listening) ?? found[0];
        return auto?.url ?? cur;
      });
    };
    void probe();
    const timer = setInterval(() => void probe(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-probe only on a changed dir, not when the label-only folder name changes
  }, [dir]);

  // A hot reload keeps the old content up until the new read lands: an agent's
  // rewrite is not atomic, and a flash of error is worse.
  const pushedNonce = pushed?.nonce;
  useEffect(() => setTyped(null), [pushedNonce]);

  const filePath = file?.path;
  const fileNonce = file?.nonce;
  // Follows what's on screen; a hot reload changes content, never the path.
  useEffect(() => setPathInput(filePath ?? ""), [filePath]);
  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    const readFile = async (initial: boolean) => {
      const res = await previewReadFile(filePath);
      if (cancelled) return;
      res.match({
        ok: (loaded) => {
          setDoc(loaded);
          setDocError(null);
          if (initial) setShowing("file");
        },
        err: (e) => {
          // The old doc goes too, else `sourceLabel` names what isn't on screen.
          if (!initial) return;
          setDoc(null);
          setDocError(errorMessage(e));
          setShowing("file");
        },
      });
    };
    void readFile(true);
    void previewWatchFile(filePath);
    const off = onPreviewFileChanged(filePath, () => void readFile(false));
    return () => {
      cancelled = true;
      off();
      void previewUnwatchFile(filePath);
    };
  }, [filePath, fileNonce]);

  /** The only way back from a failed first read: a path that never existed has
   * nothing to watch. */
  async function reloadFile() {
    if (!filePath) return;
    const res = await previewReadFile(filePath);
    res.match({
      ok: (loaded) => {
        setDoc(loaded);
        setDocError(null);
      },
      err: (e) => {
        setDoc(null);
        setDocError(errorMessage(e));
      },
    });
  }

  function navigate(next: string, source: "manual" | "config") {
    const withScheme = /^[a-z]+:\/\//i.test(next) ? next : `http://${next}`;
    // Navigating is also how you leave a shown file behind.
    setShowing("server");
    setUrl(withScheme);
    setInput(withScheme);
    setFrameKey((k) => k + 1);
    uiAction("preview.navigate", "agentboard", source);
  }

  const onFile = showing === "file" && file != null;
  const hasSurface = onFile ? doc != null : url !== "";
  // Must survive a failed read, or a call a beat before the file was written
  // leaves the pane an error with its retry button disabled.
  const canReload = onFile ? filePath != null : url !== "";
  // Names the screenshot's source: `url` is only the last dev server probed.
  const sourceLabel = onFile ? (doc?.path ?? file.path) : url;

  if (!folder) return <PanePlaceholder label="folder gone" focused={focused} onRemove={onClose} />;

  return (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-lg border bg-card",
        focused && "border-violet-500/60",
      )}
    >
      {/* Header: title + URL/server + reload/external + close */}
      <PaneChrome
        lens={<PaneLens kind="web" />}
        controls={
          onFile ? (
            <>
              {/* Identity + an address bar for it; the way back to the dev
                  server is a click, not a retyped URL. */}
              <FileCode2 className="size-3 shrink-0 text-violet-500" />
              <span className="shrink-0 truncate text-[11px] font-medium">{file.title}</span>
              <Input
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setPathInput(filePath ?? "");
                  if (e.key !== "Enter") return;
                  const next = typedPreviewRequest(pathInput);
                  if (!next) {
                    toast.error("Enter an absolute path — the app has no working directory.");
                    return;
                  }
                  setTyped(next);
                  uiAction("preview.file.open_typed", "agentboard");
                }}
                placeholder="/absolute/path/to/file.md"
                title="show another file — absolute path, Enter to open"
                className="h-6 min-w-0 flex-1 font-mono text-[10px]"
              />
              {url && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto shrink-0"
                  onClick={() => {
                    setShowing("server");
                    uiAction("preview.file.dismiss", "agentboard");
                  }}
                >
                  Dev server
                </Button>
              )}
            </>
          ) : (
            <>
              {servers.length > 0 && (
                <Select
                  value={servers.find((s) => s.url === url)?.key ?? ""}
                  onValueChange={(key) => {
                    const s = servers.find((x) => x.key === key);
                    if (s) navigate(s.url, "config");
                  }}
                >
                  <SelectTrigger size="xs" className="w-40 text-[11px]">
                    <SelectValue placeholder="Dev server" />
                  </SelectTrigger>
                  <SelectContent>
                    {servers.map((s) => (
                      <SelectItem key={s.key} value={s.key}>
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            s.listening ? "bg-green-500" : "bg-muted-foreground/40",
                          )}
                        />
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && input.trim()) navigate(input.trim(), "manual");
                }}
                placeholder="http://localhost:<port>/"
                className="h-6 min-w-0 flex-1 font-mono text-[11px]"
              />
            </>
          )
        }
        actions={
          <>
            <IconBtn
              title={onFile ? "re-read the file from disk" : "reload preview"}
              disabled={!canReload}
              className="hover:text-sky-500"
              onClick={() => {
                if (onFile) void reloadFile();
                else setFrameKey((k) => k + 1);
                uiAction("preview.reload", "agentboard", onFile ? "file" : "server");
              }}
            >
              <RotateCw className="size-3" />
            </IconBtn>
            <IconBtn
              title="open in browser"
              disabled={!hasSurface}
              className="hover:text-sky-500"
              onClick={() => {
                uiAction("preview.open_external", "agentboard");
                void openExternalUrl(onFile ? fileUrl(sourceLabel) : url);
              }}
            >
              <ExternalLink className="size-3" />
            </IconBtn>
            <IconBtn
              title="close pane (preview stays a click away on the folder)"
              shortcut={focused ? "ab-close-pane" : undefined}
              className="hover:text-sky-500"
              onClick={onClose}
            >
              <X className="size-3" />
            </IconBtn>
          </>
        }
      />

      {/* Surface: iframe or shown file, under the shared ink layer */}
      <AnnotateSurface
        folder={folder}
        capture={(rect) =>
          previewCapture({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            devicePixelRatio: window.devicePixelRatio || 1,
          })
        }
        sourceLabel={sourceLabel}
        enabled={hasSurface}
        telemetryPrefix="preview"
      >
        {onFile ? (
          docError != null ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
              <FileCode2 className="size-6 text-muted-foreground/60" />
              <div className="text-xs text-muted-foreground">
                Couldn&apos;t read the file the agent pointed at — {docError}
              </div>
            </div>
          ) : doc != null ? (
            /* Keyed on path + nonce, never content: remounting an artifact's
             * frame per rewrite would drop its scroll and its scripts' state. */
            <PreviewDocView key={`${file.path}\u0000${file.nonce}`} doc={doc} title={file.title} />
          ) : null
        ) : url ? (
          /* Unsandboxed by intent: the user's own dev server needs its origin. */
          // oxlint-disable-next-line react/iframe-missing-sandbox
          <iframe
            key={frameKey}
            src={url}
            title="Dev server preview"
            className="absolute inset-0 h-full w-full border-0 bg-white"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <AppWindow className="size-6 text-muted-foreground/60" />
            <div className="text-xs text-muted-foreground">
              No dev server found in this checkout&apos;s{" "}
              <span className="font-mono">.claude/launch.json</span> — enter a URL above.
            </div>
          </div>
        )}
      </AnnotateSurface>
    </div>
  );
}
