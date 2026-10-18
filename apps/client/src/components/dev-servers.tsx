import { Button, Popover } from "@cloudflare/kumo";
import { GlobeIcon, HardDrivesIcon, PlayIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { Result } from "effect";
import { useEffect, useState } from "react";
import { startPoll } from "@/lib/run";
import { Hint } from "@/components/hint";
import type { SessionActions } from "@/lib/agentboard/actions";
import type { FolderData } from "@/lib/agentboard/types";
import { errorMessage } from "@/lib/errors";
import {
  devServerUrl,
  launchAction,
  launchCommand,
  launchConfigs,
  type LaunchConfigStatus,
} from "@/lib/launch";
import { openExternalUrl } from "@/lib/open-url";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

/** How often the open popover re-probes ports/panes — long enough to stay
 * cheap, short enough that a just-launched server's dot flips green while
 * you watch. */
const REFRESH_MS = 3000;

/** Anthropic's reference for `.claude/launch.json` — the "Configure preview
 * servers" section of the Claude Code desktop docs. */
const LAUNCH_JSON_DOCS_URL = "https://code.claude.com/docs/en/desktop#configure-preview-servers";

/** Popover of a checkout's `.claude/launch.json` configs, each row a port-probe
 * dot and one action. The pane header mounts it for every checkout (dimmed when
 * the file is absent); the dense rail still gates on `folder.hasLaunchConfig`. */
export function DevServersButton({
  folder,
  actions,
  ghost = false,
}: {
  folder: FolderData;
  actions: SessionActions;
  /** Ghost trigger (no resting border) — see `IconBtn`'s `ghost`. */
  ghost?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<LaunchConfigStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch on open, then keep probing while open. `rows` survives a close so
  // reopening paints the last-known list instantly under the fresh fetch.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const refresh = async () => {
      Result.match(await launchConfigs(folder.dir), {
        onSuccess: (r) => {
          if (cancelled) return;
          setRows(r);
          setError(null);
        },
        onFailure: (e) => {
          if (!cancelled) setError(errorMessage(e));
        },
      });
    };
    const stop = startPoll(refresh, REFRESH_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [open, folder.dir]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      uiAction("dev_servers.opened", "agentboard", folder.hasLaunchConfig ? "configs" : "howto");
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Hint label="Dev servers (.claude/launch.json)">
        <Popover.Trigger
          render={
            <Button
              variant={ghost ? "ghost" : "outline"}
              shape="square"
              size="sm"
              aria-label="Dev servers"
              className={cn("hover:text-agent", !folder.hasLaunchConfig && "text-kumo-subtle/50")}
              onClick={(e) => e.stopPropagation()}
              icon={<HardDrivesIcon className="size-3.5" />}
            />
          }
        />
      </Hint>
      <Popover.Content align="end" className="w-96 p-2">
        <div className="flex items-baseline justify-between px-1 pb-1.5">
          <span className="text-caption font-medium">Dev servers</span>
          <Hint label="Open Anthropic's launch.json reference (Configure preview servers)">
            <button
              type="button"
              className="font-mono text-mini text-kumo-subtle/60 underline-offset-2 hover:text-agent hover:underline"
              onClick={() => {
                uiAction("dev_servers.docs_opened", "agentboard");
                void openExternalUrl(LAUNCH_JSON_DOCS_URL);
              }}
            >
              .claude/launch.json ↗
            </button>
          </Hint>
        </div>
        {error && <p className="px-1 pb-1 text-xs text-danger">{error}</p>}
        {!error &&
          rows &&
          rows.length === 0 &&
          (folder.hasLaunchConfig ? (
            <p className="px-1 pb-1 text-xs text-kumo-subtle">no launchable configurations</p>
          ) : (
            <LaunchFileHowTo />
          ))}
        {!error &&
          rows?.map((cfg) => (
            <ConfigRow
              key={cfg.name}
              cfg={cfg}
              onLaunch={() => {
                uiAction("dev_servers.launch", "agentboard");
                actions.launchDevServer(folder.dir, cfg);
              }}
              onFocus={(sessionId) => {
                uiAction("dev_servers.focus_session", "agentboard");
                setOpen(false);
                actions.focusSession(folder.dir, sessionId);
              }}
            />
          ))}
      </Popover.Content>
    </Popover>
  );
}

/** Example the empty state shows — the minimal launch.json that makes a
 * config launchable here (name + runtimeExecutable; port lights the dot). */
const EXAMPLE_LAUNCH_JSON = `{
  "configurations": [
    {
      "name": "dev",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "dev"],
      "port": 5173
    }
  ]
}`;

/** Empty state for a checkout with no `.claude/launch.json` yet: says what
 * the feature does and shows the file to create — discovery, since the
 * button now renders for every checkout in the pane header. */
function LaunchFileHowTo() {
  return (
    <div className="px-1 pb-1">
      <p className="text-xs text-kumo-subtle">
        This repo has no <span className="font-mono text-mini">.claude/launch.json</span>. Add one
        to start dev servers from here — each configuration becomes a one-click launch into its own
        terminal pane, with a running dot from its port.
      </p>
      <pre className="mt-1.5 overflow-x-auto rounded-md bg-kumo-recessed p-2 font-mono text-mini leading-snug text-kumo-subtle">
        {EXAMPLE_LAUNCH_JSON}
      </pre>
      <p className="mt-1.5 text-mini text-kumo-subtle/70">
        Configs also take <span className="font-mono">cwd</span>,{" "}
        <span className="font-mono">env</span>, <span className="font-mono">autoPort</span>, or{" "}
        <span className="font-mono">program</span> for a bare Node script — see{" "}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-agent"
          onClick={() => {
            uiAction("dev_servers.docs_opened", "agentboard");
            void openExternalUrl(LAUNCH_JSON_DOCS_URL);
          }}
        >
          Anthropic's reference
        </button>
        . Shared with Claude Desktop's dev-server previews — the same file drives both.
      </p>
    </div>
  );
}

function ConfigRow({
  cfg,
  onLaunch,
  onFocus,
}: {
  cfg: LaunchConfigStatus;
  onLaunch: () => void;
  onFocus: (sessionId: string) => void;
}) {
  const command = launchCommand(cfg);
  const action = launchAction(cfg);
  return (
    <div className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-kumo-tint">
      <Hint
        label={
          cfg.port == null
            ? "no port in launch.json — can't probe"
            : cfg.portListening
              ? `listening on :${cfg.port}`
              : "not running"
        }
      >
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            cfg.port == null ? "bg-kumo-fill" : cfg.portListening ? "bg-ok" : "bg-kumo-line",
          )}
        />
      </Hint>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-caption">{cfg.name}</span>
          {cfg.port != null && (
            <span className="font-mono text-mini text-kumo-subtle">:{cfg.port}</span>
          )}
        </div>
        <Hint label={command}>
          <div className="truncate font-mono text-mini text-kumo-subtle/60">{command}</div>
        </Hint>
      </div>
      {cfg.portListening && cfg.port != null && (
        <Hint label={`Open ${devServerUrl(cfg.port)}`}>
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            aria-label={`Open localhost:${cfg.port} in the browser`}
            onClick={() => {
              if (cfg.port == null) return;
              uiAction("dev_servers.open_url", "agentboard");
              void openExternalUrl(devServerUrl(cfg.port));
            }}
            icon={<GlobeIcon className="size-3.5" />}
          />
        </Hint>
      )}
      {action === "launch" && (
        <Hint label={`Start in a new session: ${command}`}>
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            aria-label={`Start ${cfg.name}`}
            className="hover:text-agent"
            onClick={onLaunch}
            icon={<PlayIcon className="size-3.5" />}
          />
        </Hint>
      )}
      {action === "focus" && (
        <Hint label="Focus the terminal it's running in">
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            aria-label={`Focus ${cfg.name}'s terminal`}
            className="hover:text-agent"
            onClick={() => cfg.sessionId && onFocus(cfg.sessionId)}
            icon={<TerminalWindowIcon className="size-3.5" />}
          />
        </Hint>
      )}
      {action === "external" && (
        <Hint label="Something outside the app is listening on this port — nothing to focus, and a second launch would collide">
          <span className="shrink-0 rounded-md border border-kumo-hairline px-1.5 font-mono text-mini text-kumo-subtle">
            external
          </span>
        </Hint>
      )}
    </div>
  );
}
