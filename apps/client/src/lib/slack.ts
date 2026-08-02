import { useCallback, useEffect, useState } from "react";
import type { Result } from "better-result";
import { SlackDmViewSchema, SlackFileDataSchema } from "./schemas/slack";
import { errorMessage, type IpcError } from "./errors";
import { invoke, isTauri } from "./tauri";

/** Client-side view of the watched Slack DM conversation, mirroring the Rust
 * types (camelCase, epoch-ms timestamps). A pull, not a subscription — the
 * panel refetches after a send and whenever the store re-emits. */

/** The private URLs need the token's bearer header, so images go through
 * {@link slackDmFile} rather than straight into an `<img>`. */
export type DmFile = {
  id: string;
  name: string;
  mimetype: string;
  urlPrivate: string;
  thumbUrl: string;
  permalink: string;
  isImage: boolean;
};

export type DmMessage = {
  text: string;
  ts: number;
  fromMe: boolean;
  files: DmFile[];
};

/** `configured` is false when the collector has no token/member id yet — the
 * panel shows setup guidance instead of a thread. `watchUserId` resolves
 * `<@id>` mentions to the watched name. */
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

/** Exercises the attachment layout in browser dev, where a real `url_private`
 * would need the Tauri file-fetch command. */
const MOCK_IMAGE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="150"><rect width="240" height="150" fill="#a78bfa"/><text x="120" y="80" font-family="sans-serif" font-size="18" fill="white" text-anchor="middle">photo</text></svg>`,
  );

/** Browser-dev fallback: the panel stays workable without real credentials. */
function mockView(now: number = Date.now()): SlackDmView {
  const MIN = 60_000;
  return {
    configured: true,
    watchName: "Danielle",
    watchUserId: "U_DANIELLE",
    messages: [
      {
        text: "hey, are you still on for *dinner* tonight? see <https://ex.com/menu|the menu>",
        ts: now - 42 * MIN,
        fromMe: false,
        files: [],
      },
      { text: "yes! leaving in about an hour", ts: now - 40 * MIN, fromMe: true, files: [] },
      {
        text: "found this place",
        ts: now - 38 * MIN,
        fromMe: false,
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
      },
    ],
  };
}

/** Refetches on mount, on `refresh`, and whenever the store snapshot re-emits
 * (a background tick may have landed a reply). `view` is null only during the
 * first load; `error` separates "not configured" from "broke". */
export function useSlackDm(): {
  view: SlackDmView | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [view, setView] = useState<SlackDmView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isTauri()) {
      setView(mockView());
      setLoading(false);
      return;
    }
    const loaded = await invoke<SlackDmView>("slack_dm_history", {}, { schema: SlackDmViewSchema });
    loaded.match({
      ok: (next) => {
        setView(next);
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

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const sub = await listen("store://snapshot", () => void load());
        if (disposed) sub();
        else unlisten = sub;
      } catch {
        // No Tauri event bus — the mount fetch + manual refresh still work.
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [load]);

  return { view, loading, error, refresh };
}

/** The `Err` carries the raw Slack error string (see {@link isScopeError}). The
 * command refreshes the store snapshot, which nudges {@link useSlackDm}. */
export function slackDmSend(text: string): Promise<Result<void, IpcError>> {
  return invoke<void>("slack_dm_send", { text });
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
