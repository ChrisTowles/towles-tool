import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowSquareOutIcon, ChatCircleDotsIcon, CheckIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@cloudflare/kumo";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Composer } from "@/components/slack/composer";
import { MessageBubble } from "@/components/slack/message-bubble";
import { usePinToBottom } from "@/components/slack/use-pin-to-bottom";
import { cn } from "@/lib/utils";
import {
  dmsNeedingAttention,
  fmtAge,
  storeDmDismiss,
  useStoreSnapshot,
  type DmItem,
} from "@/lib/data";
import { useNow } from "@/lib/now";
import { openExternalUrl } from "@/lib/open-url";
import type { PastedImage } from "@/lib/pasted-images";
import { slackDmReact, slackDmSend, slackWriteError, useSlackDm } from "@/lib/slack";
import { isTauri } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";
import { useWorkspace } from "@/lib/workspace";

/** Unanswered this long → the age turns into a chip. */
const WARN_MS = 5 * 60_000;
/** Unanswered this long → the edge pulses and the OS taskbar flashes. */
const ALARM_MS = 10 * 60_000;
/** The drawer is for answering, not reading history — the Slack tab has that. */
const RECENT_MESSAGES = 12;

/** A watched DM waiting on you slides in over the right edge of every screen,
 * and slides away once you reply or mark it handled. Mounted outside the
 * screens, so no repo, task or tab switch hides it; it never takes focus
 * until clicked, so a terminal keeps its keystrokes. */
export function DmDrawer() {
  const { snapshot } = useStoreSnapshot();
  // A sent reply hides the drawer at once; the store's dismissal lands a beat later.
  const [answeredTs, setAnsweredTs] = useState(0);
  const pending = dmsNeedingAttention(snapshot).filter((d) => d.ts > answeredTs);
  const dm = pending[0];

  return (
    <AnimatePresence>
      {dm && (
        <motion.aside
          key="dm-drawer"
          aria-label={`Message from ${dm.fromName}`}
          className="absolute inset-y-0 right-0 z-40 flex w-[380px] max-w-full flex-col border-l-4 border-l-danger bg-background shadow-2xl"
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring", stiffness: 380, damping: 38 }}
        >
          <DrawerBody dm={dm} more={pending.length - 1} onAnswered={setAnsweredTs} />
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function DrawerBody({
  dm,
  more,
  onAnswered,
}: {
  dm: DmItem;
  more: number;
  onAnswered: (ts: number) => void;
}) {
  const { openTab } = useWorkspace();
  const now = useNow();
  const { view, refresh } = useSlackDm();
  const [sending, setSending] = useState(false);
  const { viewportRef, listRef, composerRef, repin } = usePinToBottom(true);
  const flashedTs = useRef(0);

  useEffect(() => {
    uiAction("dm_drawer.open", "slack");
  }, [dm.ts]);

  const age = now - dm.ts;
  const alarm = age >= ALARM_MS;
  const warn = age >= WARN_MS;

  useEffect(() => {
    if (!alarm || flashedTs.current === dm.ts || !isTauri()) return;
    flashedTs.current = dm.ts;
    void (async () => {
      try {
        const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
        await getCurrentWindow().requestUserAttention(UserAttentionType.Critical);
      } catch {
        // Best-effort: the in-app pulse still carries the escalation.
      }
    })();
  }, [alarm, dm.ts]);

  const send = useCallback(
    async (text: string, images: PastedImage[]) => {
      uiAction("dm_drawer.reply", "slack", images.length > 0 ? "with_images" : undefined);
      repin();
      setSending(true);
      const sent = await slackDmSend(text, undefined, images);
      setSending(false);
      return sent.match({
        ok: () => {
          onAnswered(dm.ts);
          void storeDmDismiss(dm.channel, dm.ts);
          refresh();
          return true;
        },
        err: (e) => {
          toast.error(slackWriteError(e.message, "send"));
          return false;
        },
      });
    },
    [dm.channel, dm.ts, onAnswered, refresh, repin],
  );

  const toggleReaction = useCallback(
    (ts: string, name: string, add: boolean) => {
      uiAction(add ? "dm_drawer.react" : "dm_drawer.unreact", "slack");
      void slackDmReact(ts, name, add).then((done) =>
        done.match({
          ok: refresh,
          err: (e) => toast.error(slackWriteError(e.message, "react")),
        }),
      );
    },
    [refresh],
  );

  const messages = (view?.messages ?? []).slice(-RECENT_MESSAGES);

  return (
    <>
      <header className="relative isolate flex shrink-0 items-center gap-2 border-b border-kumo-hairline bg-danger/15 px-3 py-2.5">
        {alarm && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-danger"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.35, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full bg-danger/30 text-danger",
            alarm && "bg-danger text-white",
          )}
        >
          <ChatCircleDotsIcon className="size-4" />
        </span>
        <span className="min-w-0 truncate font-semibold text-kumo-default">{dm.fromName}</span>
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 font-mono text-mini text-kumo-default/60",
            warn && "bg-danger/30 font-medium text-danger",
            alarm && "bg-danger text-white",
          )}
        >
          {fmtAge(dm.ts, now)}
        </span>
        {more > 0 && (
          <span className="shrink-0 font-mono text-mini text-kumo-default/60">+{more}</span>
        )}
        <div className="flex-1" />
        {dm.url && (
          <Button
            variant="ghost"
            shape="square"
            size="xs"
            aria-label="Open in Slack"
            title="Open in Slack"
            className="text-kumo-default/70"
            icon={<ArrowSquareOutIcon className="size-3.5" />}
            onClick={() => {
              uiAction("dm_drawer.open_slack", "slack");
              void openExternalUrl(dm.url!);
            }}
          />
        )}
        <Button
          variant="ghost"
          size="xs"
          className="text-kumo-default/70"
          icon={<CheckIcon className="size-3.5" />}
          onClick={() => {
            uiAction("dm_drawer.dismiss", "slack");
            onAnswered(dm.ts);
            void storeDmDismiss(dm.channel, dm.ts);
          }}
        >
          Handled
        </Button>
      </header>

      <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
        <div ref={listRef} className="flex flex-col gap-1.5 px-3 py-3">
          {messages.length === 0 && (
            <p className="py-6 text-center text-sm text-kumo-default/75">{dm.text}</p>
          )}
          {messages.map((m, i) => (
            <MessageBubble
              key={m.tsRaw || `${m.ts}-${i}`}
              message={m}
              watchUserId={view?.watchUserId}
              watchName={view?.watchName}
              actions={{ onToggleReaction: toggleReaction }}
            />
          ))}
          <button
            type="button"
            className="self-center pt-1 text-mini text-kumo-subtle hover:text-kumo-default"
            onClick={() => {
              uiAction("dm_drawer.open_tab", "slack");
              openTab("slack");
            }}
          >
            Full conversation and threads
          </button>
        </div>
      </ScrollArea>

      <div ref={composerRef} className="shrink-0 border-t border-kumo-hairline bg-kumo-base p-3">
        <Composer
          compact
          acceptImages
          placeholder={`Reply to ${dm.fromName}…`}
          sending={sending}
          onSend={send}
        />
      </div>
    </>
  );
}
