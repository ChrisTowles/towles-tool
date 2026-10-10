import { useState } from "react";
import {
  ArrowSquareOutIcon,
  BracketsCurlyIcon,
  ChatCircleIcon,
  CheckIcon,
  CopyIcon,
  GearIcon,
  KeyIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { toast } from "@/lib/toast";
import { Button, Dialog } from "@cloudflare/kumo";
import { ScrollArea } from "@/components/ui/scroll-area";
import { isAuthError, isScopeError } from "@/lib/slack";
import { openExternalUrl } from "@/lib/open-url";
import { uiAction } from "@/lib/ui-action";
import { useWorkspace } from "@/lib/workspace";

/** api.slack.com app directory — where the app is created and tokens are issued. */
const SLACK_APPS_URL = "https://api.slack.com/apps";

/** The app manifest to paste into "Create app → From a manifest". `reactions:read`
 * and the two reaction events are what make a 👍 from the other side show up
 * without waiting for the next poll. */
const APP_MANIFEST = `{
  "display_information": { "name": "Towles Tool DM Watch" },
  "oauth_config": {
    "scopes": {
      "user": [
        "im:history", "im:read", "im:write", "chat:write",
        "users:read", "users:read.email", "mpim:history", "mpim:read",
        "search:read", "reactions:read", "reactions:write", "files:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "user_events": ["message.im", "reaction_added", "reaction_removed"]
    }
  }
}`;

/** A copy-to-clipboard button that flips to a check for a moment after copying. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      uiAction("slack.copy", "slack", label);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy to clipboard.");
    }
  };
  return (
    <Button
      size="sm"
      variant="outline"
      className="px-2 text-xs"
      icon={
        copied ? (
          <CheckIcon className="size-3.5 text-emerald-500" />
        ) : (
          <CopyIcon className="size-3.5" />
        )
      }
      onClick={() => void copy()}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

export function ManifestBlock() {
  return (
    <div className="overflow-hidden rounded-md border border-kumo-hairline bg-muted/40">
      <div className="flex items-center justify-between border-b border-kumo-hairline bg-muted/60 px-2.5 py-1.5">
        <span className="font-mono text-[11px] text-kumo-subtle">app manifest</span>
        <CopyButton text={APP_MANIFEST} label="Copy manifest" />
      </div>
      <pre className="max-h-52 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-foreground">
        {APP_MANIFEST}
      </pre>
    </div>
  );
}

/** A link that opens in the OS browser (never navigating the webview). */
function ExternalLinkText({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => {
        uiAction("slack.open_external", "slack");
        void openExternalUrl(url);
      }}
      className="inline-flex items-center gap-0.5 font-medium text-violet-600 underline underline-offset-2 hover:text-violet-500 dark:text-violet-300"
    >
      {children}
      <ArrowSquareOutIcon className="size-3" />
    </button>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-xs font-semibold text-violet-600 dark:text-violet-300">
        {n}
      </span>
      <div className="flex-1 text-[13px] leading-relaxed">
        <div className="mb-1 font-medium text-foreground">{title}</div>
        {children}
      </div>
    </li>
  );
}

/** The manifest, reachable once Slack is already configured — the setup guide
 * that otherwise holds it is only shown before setup, so a scope added later
 * would have nowhere to be seen. */
export function AppManifestDialog() {
  return (
    <Dialog.Root onOpenChange={(open) => open && uiAction("slack.manifest_open", "slack")}>
      <Dialog.Trigger
        render={(p) => (
          <Button
            {...p}
            variant="ghost"
            size="sm"
            className="px-2 text-kumo-subtle"
            icon={<BracketsCurlyIcon className="size-3.5" />}
          >
            App manifest
          </Button>
        )}
      />
      <Dialog size="lg" className="p-6">
        <div className="mb-4 flex flex-col gap-1.5">
          <Dialog.Title className="text-lg font-semibold">Slack app manifest</Dialog.Title>
          <Dialog.Description className="text-kumo-subtle">
            Reactions arrive live only with <span className="font-mono">reactions:read</span> and
            the two reaction events. Paste this at{" "}
            <ExternalLinkText url={SLACK_APPS_URL}>api.slack.com/apps</ExternalLinkText> → your app
            → App Manifest, save, then reinstall from Install App and paste the fresh{" "}
            <span className="font-mono">xoxp-…</span> token into Settings.
          </Dialog.Description>
        </div>
        <ManifestBlock />
      </Dialog>
    </Dialog.Root>
  );
}

/** Full walkthrough shown when Slack isn't configured yet: create the app from a
 * manifest, install it, copy the tokens, and open Settings to finish. */
export function SetupGuide() {
  const { openSettingsTab } = useWorkspace();
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto w-full max-w-xl px-6 py-8">
        <div className="mb-4 flex items-center gap-2.5">
          <ChatCircleIcon className="size-5 text-violet-500" />
          <h2 className="text-base font-semibold text-foreground">Connect a Slack DM</h2>
        </div>
        <p className="mb-5 text-[13px] leading-relaxed text-kumo-subtle">
          Watch one direct message (e.g. your partner) and reply without leaving the app. A one-time
          Slack setup:
        </p>
        <ol className="flex flex-col gap-4">
          <Step n={1} title="Create a Slack app from the manifest">
            <p className="text-kumo-subtle">
              Go to <ExternalLinkText url={SLACK_APPS_URL}>api.slack.com/apps</ExternalLinkText> →{" "}
              <span className="font-medium text-foreground">Create New App</span> →{" "}
              <span className="font-medium text-foreground">From a manifest</span>, choose your
              workspace, and paste this:
            </p>
            <div className="mt-2">
              <ManifestBlock />
            </div>
          </Step>
          <Step n={2} title="Install it to your workspace">
            <p className="text-kumo-subtle">
              On the app's <span className="font-medium text-foreground">Install App</span> page,
              click Install and then <span className="font-medium text-foreground">Allow</span>.
            </p>
          </Step>
          <Step n={3} title="Copy the User OAuth Token">
            <p className="text-kumo-subtle">
              From <span className="font-medium text-foreground">OAuth &amp; Permissions</span>,
              copy the <span className="font-mono">xoxp-…</span> User OAuth Token.
            </p>
          </Step>
          <Step n={4} title="Generate an app-level token (for live updates)">
            <p className="text-kumo-subtle">
              Recommended: under{" "}
              <span className="font-medium text-foreground">
                Basic Information → App-Level Tokens
              </span>
              , generate a token with the <span className="font-mono">connections:write</span> scope
              (<span className="font-mono">xapp-…</span>). Without it, messages and reactions arrive
              on a 60-second poll instead of instantly.
            </p>
          </Step>
          <Step n={5} title="Paste both tokens and pick who to watch">
            <p className="text-kumo-subtle">
              In Settings → Slack, paste the tokens and choose the person to watch.
            </p>
            <div className="mt-2">
              <Button
                size="sm"
                variant="primary"
                icon={<GearIcon className="size-3.5" />}
                onClick={() => {
                  uiAction("slack.open_settings", "slack");
                  openSettingsTab({ tab: "collectors", filter: "slack" });
                }}
              >
                Open Slack settings
              </Button>
            </div>
          </Step>
        </ol>
      </div>
    </ScrollArea>
  );
}

/** Compact re-auth walkthrough shown when a configured token is rejected. */
function ReauthNotice({ onRetry }: { onRetry: () => void }) {
  const { openSettingsTab } = useWorkspace();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-kumo-hairline bg-kumo-base p-6">
        <div className="mb-2 flex items-center gap-2">
          <KeyIcon className="size-5 text-amber-500" />
          <h2 className="text-sm font-semibold text-foreground">Your Slack token expired</h2>
        </div>
        <p className="mb-3 text-[13px] leading-relaxed text-kumo-subtle">
          Slack rejected the token (<span className="font-mono">invalid_auth</span>). Re-issue it
          and paste the fresh one:
        </p>
        <ol className="mb-4 flex flex-col gap-1.5 text-[13px] text-kumo-subtle">
          <li>
            1. Open your app at{" "}
            <ExternalLinkText url={SLACK_APPS_URL}>api.slack.com/apps</ExternalLinkText> → OAuth
            &amp; Permissions.
          </li>
          <li>
            2. Reinstall if prompted, then copy the new <span className="font-mono">xoxp-…</span>{" "}
            token.
          </li>
          <li>3. Paste it in Settings → Slack and Save.</li>
        </ol>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="primary"
            icon={<GearIcon className="size-3.5" />}
            onClick={() => {
              uiAction("slack.open_settings", "slack");
              openSettingsTab({ tab: "collectors", filter: "slack" });
            }}
          >
            Open Slack settings
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              uiAction("slack.retry", "slack");
              onRetry();
            }}
          >
            Retry
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Shown when history fetch failed outright. A dead token routes to the re-auth
 * walkthrough; a missing scope to a scope hint. */
export function FetchError({ error, onRetry }: { error: string; onRetry: () => void }) {
  if (isAuthError(error)) return <ReauthNotice onRetry={onRetry} />;
  const scope = isScopeError(error);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="max-w-sm rounded-lg border border-kumo-hairline bg-kumo-base p-6 text-center">
        {scope ? (
          <KeyIcon className="mx-auto mb-3 size-6 text-amber-500" />
        ) : (
          <WarningIcon className="mx-auto mb-3 size-6 text-red-500" />
        )}
        <h2 className="mb-1 text-sm font-semibold text-foreground">
          {scope ? "Token needs more access" : "Couldn't load the conversation"}
        </h2>
        <p className="mb-4 text-[13px] leading-relaxed break-words text-kumo-subtle">
          {scope
            ? "Re-authorize your Slack token with the chat:write and reactions:write scopes, then retry."
            : error}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            uiAction("slack.retry", "slack");
            onRetry();
          }}
        >
          Retry
        </Button>
      </div>
    </div>
  );
}
