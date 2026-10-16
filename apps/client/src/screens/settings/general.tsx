import { useEffect, useState } from "react";
import { Button, Input, Select } from "@cloudflare/kumo";
import type { UserSettings } from "@/lib/settings";
import { errorMessage, NotInTauri } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";
import {
  checkForUpdate,
  rollbackUpdate,
  updateLabel,
  updateStatus,
  type UpdateChannel,
  type UpdateStatus,
} from "@/lib/update";
import { FieldRow, SettingRow, type FilterSection, type Flush, type Update } from "./common";

const CHANNELS: { value: UpdateChannel; label: string; description: string }[] = [
  {
    value: "stable",
    label: "Releases",
    description: "Published releases only.",
  },
  {
    value: "main",
    label: "Every push to main",
    description: "The build of the newest commit on main, signed like a release.",
  },
];

export function generalSections(
  settings: UserSettings,
  update: Update,
  flush: Flush,
): FilterSection[] {
  return [
    {
      rows: [
        {
          label: "Preferred editor",
          keywords: ["repo", "open", "editor", "code", "cursor", "nvim"],
          node: (
            <FieldRow
              label="Preferred editor"
              description="Command used to open a repo (e.g. code, cursor, nvim). Runs as “<editor> <dir>”."
            >
              <Input
                aria-label="Preferred editor"
                value={settings.preferredEditor}
                onChange={(e) =>
                  update((s) => ({ ...s, preferredEditor: e.target.value }), { defer: true })
                }
                onBlur={() => void flush()}
                placeholder="code"
                className="max-w-xs font-mono text-xs"
                spellCheck={false}
              />
            </FieldRow>
          ),
        },
      ],
    },
    {
      heading: "Updates",
      keywords: ["update", "release", "channel", "rollback", "version", "main"],
      rows: [
        {
          label: "Update channel",
          keywords: ["channel", "main", "release", "nightly", "beta"],
          node: (
            <UpdateChannelRow
              channel={settings.updates?.channel ?? "stable"}
              onChannel={async (channel) => {
                update((s) => ({ ...s, updates: { ...s.updates, channel } }));
                await flush();
              }}
            />
          ),
        },
        {
          label: "Roll back",
          keywords: ["rollback", "downgrade", "previous", "revert"],
          node: <RollbackRow />,
        },
      ],
    },
  ];
}

function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    void updateStatus().then((r) => setStatus(r.unwrapOr(null)));
  }, []);
  return status;
}

function UpdateChannelRow({
  channel,
  onChannel,
}: {
  channel: UpdateChannel;
  onChannel: (channel: UpdateChannel) => Promise<void>;
}) {
  const status = useUpdateStatus();
  const current = CHANNELS.find((c) => c.value === channel) ?? CHANNELS[0];
  const fromSource = status !== null && !status.installed;
  const description = fromSource
    ? `${current.description} This build is from source (${status.build}), so it updates with git pull.`
    : current.description;

  return (
    <SettingRow label="Update channel" description={description}>
      <Select
        aria-label="Update channel"
        className="w-48"
        value={channel}
        onValueChange={(v) => {
          if (!v || v === channel) return;
          const next = v as UpdateChannel;
          uiAction("settings.update_channel", "settings", next);
          void (async () => {
            await onChannel(next);
            if (fromSource) return;
            const found = await checkForUpdate();
            if (found.isErr()) {
              if (!NotInTauri.is(found.error)) {
                toast.error(`Couldn't check for updates — ${errorMessage(found.error)}`);
              }
            } else if (found.value) {
              toast.info(`${updateLabel(found.value)} is ready to install`);
            } else {
              toast.success("You're on the newest build of this channel");
            }
          })();
        }}
        items={CHANNELS.map((c) => ({ value: c.value, label: c.label }))}
      />
    </SettingRow>
  );
}

function RollbackRow() {
  const status = useUpdateStatus();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const target = status?.rollbackTo ?? null;

  const description = target
    ? `Reinstall release ${target}, the one the last update replaced, and restart. Running terminals end.`
    : "Available after the app updates itself: it reinstalls the release that update replaced.";

  const rollback = async () => {
    setBusy(true);
    uiAction("settings.update_rollback", "settings", target ?? undefined);
    const result = await rollbackUpdate();
    setBusy(false);
    setArmed(false);
    if (result.isErr()) toast.error(`Couldn't roll back — ${errorMessage(result.error)}`);
  };

  return (
    <SettingRow label="Roll back" description={description}>
      {armed ? (
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setArmed(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={() => void rollback()} disabled={busy}>
            {busy ? "Installing…" : `Roll back to ${target}`}
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" disabled={!target} onClick={() => setArmed(true)}>
          Roll back…
        </Button>
      )}
    </SettingRow>
  );
}
