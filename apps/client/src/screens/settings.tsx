import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowClockwiseIcon,
  GitBranchIcon,
  InfoIcon,
  KeyboardIcon,
  MagnifyingGlassIcon,
  NotebookIcon,
  PaletteIcon,
  SlidersHorizontalIcon,
} from "@phosphor-icons/react";
import { Input, Tabs } from "@cloudflare/kumo";
import { useTheme } from "@/components/theme-provider";
import { useStoreSnapshot } from "@/lib/data";
import { useNow } from "@/lib/now";
import { isEmptyQuery } from "@/lib/settings-filter";
import { settingsTargetStore, type SettingsTarget } from "@/lib/settings-target";
import { useUserSettings, type SaveState } from "@/lib/settings";
import { uiAction } from "@/lib/ui-action";
import { useAppVersion } from "@/lib/version";
import { FilteredContent, SettingsLoading, TabHeading } from "./settings/common";
import { generalSections } from "./settings/general";
import { appearanceSections } from "./settings/appearance";
import { journalSections } from "./settings/journal";
import { collectorsSections, RefreshNowButton } from "./settings/collectors";
import { agentboardSections } from "./settings/agentboard";
import { PcKeybindingsRow, ShortcutCoachRow, ShortcutsList } from "./settings/shortcuts";
import { AboutInfo } from "./settings/about";

const TABS = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "agentboard", label: "Agentboard", icon: GitBranchIcon },
  { id: "journal", label: "Journal", icon: NotebookIcon },
  { id: "collectors", label: "Collectors", icon: ArrowClockwiseIcon },
  { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon },
  { id: "about", label: "About", icon: InfoIcon },
] as const;

/** The tab + prefilled filter this screen was deep-linked to (see
 * `useWorkspace().openSettingsTab`), consumed once from `settingsTargetStore`.
 * An unknown tab falls back to General. */
function resolveTarget(target: SettingsTarget | null): {
  tab: string;
  filter: string;
} {
  const fallback = { tab: "general", filter: "" };
  if (!target) return fallback;
  const known = TABS.some((t) => t.id === target.tab);
  return { tab: known ? target.tab : "general", filter: target.filter ?? "" };
}

/** Footer readout for the autosave. With no Save button there's nothing to
 * retry, so a failure has to stay on screen; idle/saved can be quiet. */
function SaveStatus({ state }: { state: SaveState }) {
  if (state === "error") {
    return (
      <span className="text-xs text-kumo-danger">
        Couldn&rsquo;t save — your last change wasn&rsquo;t written to disk.
      </span>
    );
  }
  const label =
    state === "saving" ? "Saving…" : state === "saved" ? "Saved." : "Changes save automatically.";
  return <span className="text-xs text-kumo-subtle">{label}</span>;
}

export function SettingsScreen() {
  const { theme, setTheme, colorTheme, setColorTheme } = useTheme();
  const { settings, saveState, update, flush } = useUserSettings();
  const { snapshot } = useStoreSnapshot();
  const now = useNow();
  const version = useAppVersion();
  // Consume the store exactly once (on mount) so the tab/filter initializers
  // below don't race each other for the same one-shot target.
  const [initialTarget] = useState(() => settingsTargetStore.consume());
  const initialResolved = resolveTarget(initialTarget);
  const [tab, setTab] = useState(initialResolved.tab);
  const [query, setQuery] = useState(initialResolved.filter);
  const filterRef = useRef<HTMLInputElement>(null);

  // A deep link fired while this screen is already mounted (just hidden)
  // doesn't remount it, so watch the store and re-apply a fresh target live.
  const pendingTarget = useSyncExternalStore(
    settingsTargetStore.subscribe,
    settingsTargetStore.get,
    settingsTargetStore.get,
  );
  useEffect(() => {
    if (!pendingTarget) return;
    const resolved = resolveTarget(settingsTargetStore.consume());
    setTab(resolved.tab);
    setQuery(resolved.filter);
  }, [pendingTarget]);

  const run = (key: string) => snapshot.runs.find((r) => r.collector === key);

  // Escape clears the filter (a second, empty-box Escape has no further
  // action here — closing this screen is the close-tab shortcut's job, not
  // one owned by the filter input).
  const onFilterKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape") return;
    if (isEmptyQuery(query)) return;
    e.preventDefault();
    setQuery("");
  };

  const collectorsPrelude = (
    <div className="rounded-md border border-dashed p-3 text-xs text-kumo-subtle">
      Changes save as you make them — the scheduler re-reads its cadence live.
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-kumo-hairline bg-kumo-base px-4 py-3">
        <h1 className="font-heading text-sm font-semibold">Settings</h1>
        <div className="relative ml-auto w-56">
          <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-kumo-subtle" />
          <Input
            ref={filterRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onFilterKeyDown}
            placeholder="Filter settings…"
            className="pl-7"
            autoFocus
            spellCheck={false}
            aria-label="Filter settings"
          />
        </div>
      </header>

      <Tabs
        variant="underline"
        value={tab}
        onValueChange={(v) => {
          uiAction("settings.tab", "settings", v);
          setTab(v);
        }}
        tabs={TABS.map((t) => ({
          value: t.id,
          label: (
            <span className="flex items-center gap-2">
              <t.icon className="size-4" />
              {t.label}
            </span>
          ),
        }))}
        className="shrink-0 border-b border-kumo-hairline bg-kumo-base px-2"
      />

      <div
        role="tabpanel"
        aria-label={TABS.find((t) => t.id === tab)?.label}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {tab === "general" && (
          <div className="flex flex-col gap-5 p-4">
            <TabHeading title="General" note="Editor used to open repos." />
            {settings ? (
              <FilteredContent query={query} sections={generalSections(settings, update, flush)} />
            ) : (
              <SettingsLoading />
            )}
          </div>
        )}

        {tab === "appearance" && (
          <div className="flex flex-col gap-5 p-4">
            <TabHeading title="Appearance" note="Theme applies immediately across the app." />
            <FilteredContent
              query={query}
              sections={appearanceSections(theme, setTheme, colorTheme, setColorTheme)}
            />
          </div>
        )}

        {tab === "agentboard" && (
          <div className="flex flex-col gap-5 p-4">
            <TabHeading title="Agentboard" note="Repo discovery and needs-you notifications." />
            <FilteredContent query={query} sections={agentboardSections(settings, update, flush)} />
          </div>
        )}

        {tab === "journal" && (
          <div className="flex flex-col gap-5 p-4">
            <TabHeading
              title="Journal"
              note="Where notes live and how their file paths are templated."
            />
            {settings ? (
              <FilteredContent query={query} sections={journalSections(settings, update, flush)} />
            ) : (
              <SettingsLoading />
            )}
          </div>
        )}

        {tab === "collectors" && (
          <div className="flex flex-col gap-5 p-4">
            <TabHeading
              title="Collectors"
              note="Background jobs that fill the data hub. Each has an enable flag and cadence."
              action={<RefreshNowButton />}
            />
            {settings ? (
              <FilteredContent
                query={query}
                sections={collectorsSections(settings, update, run, now, flush)}
                prelude={collectorsPrelude}
              />
            ) : (
              <SettingsLoading />
            )}
          </div>
        )}

        {tab === "shortcuts" && (
          <div className="flex flex-col gap-5 p-4">
            <TabHeading
              title="Shortcuts"
              note="Keyboard shortcuts (⌘ on macOS unless PC-style keybindings are on, Ctrl elsewhere). Agentboard-scoped ones only fire while that tab is active. Press ? in the app for the same list."
            />
            {settings && <PcKeybindingsRow settings={settings} update={update} query={query} />}
            {settings && <ShortcutCoachRow settings={settings} update={update} query={query} />}
            <ShortcutsList query={query} />
          </div>
        )}

        {tab === "about" && (
          <div className="flex flex-col gap-5 p-4">
            <TabHeading title="About" note="Towles Tool desktop app." />
            <AboutInfo query={query} version={version} />
          </div>
        )}
      </div>
      <footer className="flex items-center justify-end gap-3 border-t border-kumo-hairline bg-kumo-base px-4 py-3">
        <SaveStatus state={saveState} />
      </footer>
    </div>
  );
}
