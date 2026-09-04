import { useCallback, useEffect, useState } from "react";
import { Result } from "better-result";
import { SlackDmViewSchema, SlackFileDataSchema, SlackThreadSchema } from "./schemas/slack";
import { errorMessage, type IpcError } from "./errors";
import { invoke, isTauri } from "./tauri";
import { useStoreSnapshot } from "./store-snapshot";
import type { DmItem } from "./data";

/** Private URLs need the bearer header, so images go through {@link slackDmFile}. */
export type DmFile = {
  id: string;
  name: string;
  mimetype: string;
  urlPrivate: string;
  thumbUrl: string;
  permalink: string;
  isImage: boolean;
};

/** One aggregated emoji reaction. `name` is the bare Slack shortcode, which is
 * also what {@link slackDmReact} sends back. */
export type DmReaction = {
  name: string;
  count: number;
  mine: boolean;
};

export type DmMessage = {
  /** Slack's `"seconds.micros"` id — what threads and reactions are keyed by. */
  tsRaw: string;
  text: string;
  ts: number;
  fromMe: boolean;
  files: DmFile[];
  reactions: DmReaction[];
  /** The thread this belongs to; on a parent it equals `tsRaw`. */
  threadTs: string;
  replyCount: number;
  latestReplyTs: number;
};

/** `configured` is false when the collector has no token/member id yet.
 * `watchUserId` resolves `<@id>` mentions to the watched name. */
export type SlackDmView = {
  configured: boolean;
  watchName: string;
  watchUserId: string;
  messages: DmMessage[];
};

export type SlackFileData = {
  mimetype: string;
  dataBase64: string;
};

/** Lets the panel show a "re-auth for images" placeholder, not a hard error. */
export function isFileScopeError(message: string): boolean {
  return message.includes("files:read");
}

/** Missing `chat:write`. The DM *watcher* only needs read scopes, so an
 * existing token predates two-way chat and must be re-authorized. */
const SCOPE_ERROR_CODES = ["missing_scope", "not_allowed_token_type"] as const;

export function isScopeError(message: string): boolean {
  return SCOPE_ERROR_CODES.some((code) => message.includes(code));
}

/** The token itself is bad — the fix is to re-issue and paste a fresh one. */
const AUTH_ERROR_CODES = [
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "not_authed",
] as const;

export function isAuthError(message: string): boolean {
  return AUTH_ERROR_CODES.some((code) => message.includes(code));
}

/** A real `url_private` would need the Tauri file-fetch command. */
const MOCK_IMAGE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="150"><rect width="240" height="150" fill="#a78bfa"/><text x="120" y="80" font-family="sans-serif" font-size="18" fill="white" text-anchor="middle">photo</text></svg>`,
  );

const MIN = 60_000;
const MOCK_NOW = () => Date.now();
const MOCK_THREAD_TS = "1720000100.000100";

function msg(over: Partial<DmMessage> & Pick<DmMessage, "text" | "ts" | "fromMe">): DmMessage {
  return {
    tsRaw: `${over.ts / 1000}`,
    files: [],
    reactions: [],
    threadTs: "",
    replyCount: 0,
    latestReplyTs: 0,
    ...over,
  };
}

function mockView(now: number = MOCK_NOW()): SlackDmView {
  return {
    configured: true,
    watchName: "Danielle",
    watchUserId: "U_DANIELLE",
    messages: [
      msg({
        text: "hey, are you still on for *dinner* tonight? see <https://ex.com/menu|the menu>",
        ts: now - 42 * MIN,
        fromMe: false,
        reactions: [{ name: "+1", count: 1, mine: true }],
      }),
      msg({ text: "yes! leaving in about an hour :tada:", ts: now - 40 * MIN, fromMe: true }),
      msg({
        text: "found this place",
        ts: now - 38 * MIN,
        fromMe: false,
        reactions: [
          { name: "heart", count: 2, mine: true },
          { name: "shipit", count: 1, mine: false },
        ],
        files: [
          {
            id: "F_MOCK",
            name: "storefront.png",
            mimetype: "image/png",
            urlPrivate: MOCK_IMAGE,
            thumbUrl: MOCK_IMAGE,
            permalink: "https://ex.com/photo",
            isImage: true,
          },
        ],
      }),
      msg({
        tsRaw: MOCK_THREAD_TS,
        text: "weekend plan — putting the details in a thread",
        ts: now - 30 * MIN,
        fromMe: false,
        threadTs: MOCK_THREAD_TS,
        replyCount: 2,
        latestReplyTs: now - 12 * MIN,
      }),
    ],
  };
}

function mockThread(now: number = MOCK_NOW()): DmMessage[] {
  const parent = mockView(now).messages.at(-1);
  return [
    ...(parent ? [parent] : []),
    msg({
      text: "saturday: swim lessons at 9",
      ts: now - 20 * MIN,
      fromMe: false,
      threadTs: MOCK_THREAD_TS,
    }),
    msg({
      text: "got it :white_check_mark:",
      ts: now - 12 * MIN,
      fromMe: true,
      threadTs: MOCK_THREAD_TS,
      reactions: [{ name: "heart", count: 1, mine: false }],
    }),
  ];
}

/** A fresh object for identical content reloads every image. */
function sameView(a: SlackDmView | null, b: SlackDmView): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

/** The only part of a snapshot that says this conversation moved: every write
 * path runs the collector, which restamps `fetchedAt`. The rest is noise. */
export function dmSignal(dms: DmItem[]): string {
  return dms.map((d) => `${d.channel}:${d.ts}:${d.fetchedAt}:${d.dismissedTs}`).join("|");
}

/** The panel works with the watcher off, where no write ever lands, so it also
 * pulls on its own. Each load restarts the wait. */
const IDLE_REFETCH_MS = 60_000;

/** Refetches on mount, on `refresh`, when {@link dmSignal} moves and on the
 * idle timer. `revision` counts loads so an open thread refetches off the same
 * triggers — a reply leaves every top-level message byte-identical. */
export function useSlackDm(): {
  view: SlackDmView | null;
  loading: boolean;
  error: string | null;
  revision: number;
  refresh: () => void;
} {
  const [view, setView] = useState<SlackDmView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const signal = dmSignal(useStoreSnapshot().snapshot.dms);

  const load = useCallback(async () => {
    setRevision((n) => n + 1);
    if (!isTauri()) {
      setView(mockView());
      setLoading(false);
      return;
    }
    const loaded = await invoke<SlackDmView>("slack_dm_history", {}, { schema: SlackDmViewSchema });
    loaded.match({
      ok: (next) => {
        setView((prev) => (sameView(prev, next) ? prev : next));
        setError(null);
      },
      err: (e) => setError(errorMessage(e)),
    });
    setLoading(false);
  }, []);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void load();
    if (!isTauri()) return;
    const idle = window.setInterval(() => void load(), IDLE_REFETCH_MS);
    return () => window.clearInterval(idle);
  }, [load, signal]);

  return { view, loading, error, revision, refresh };
}

/** The `Err` carries the raw Slack error string (see {@link isScopeError}); the
 * command refreshes the store, which nudges {@link useSlackDm}. */
export function slackDmSend(text: string, threadTs?: string): Promise<Result<void, IpcError>> {
  return invoke<void>("slack_dm_send", { text, threadTs: threadTs ?? null });
}

/** Toggle one of my reactions on a message. Slack treats a redundant toggle as
 * success, so an optimistic chip never has to be rolled back. */
export function slackDmReact(
  ts: string,
  name: string,
  add: boolean,
): Promise<Result<void, IpcError>> {
  return invoke<void>("slack_dm_react", { ts, name, add });
}

/** A thread's parent followed by its replies, oldest first. */
export function slackDmThread(threadTs: string): Promise<Result<DmMessage[], IpcError>> {
  if (!isTauri()) return Promise.resolve(Result.ok(mockThread()));
  return invoke<DmMessage[]>("slack_dm_thread", { threadTs }, { schema: SlackThreadSchema });
}

/** The webview can't load `url_private` directly, so bytes come back base64 over
 * IPC. Fails with {@link isFileScopeError} when the token lacks `files:read`. */
export function slackDmFile(url: string): Promise<Result<SlackFileData, IpcError>> {
  return invoke<SlackFileData>("slack_dm_file", { url }, { schema: SlackFileDataSchema });
}

export type SlackUser = {
  id: string;
  name: string;
};

/** Empty when the token is blank, so the picker degrades to a text input. */
export function slackListUsers(): Promise<Result<SlackUser[], IpcError>> {
  return invoke<SlackUser[]>("slack_list_users");
}
