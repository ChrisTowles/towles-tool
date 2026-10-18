import { Effect, Result, Stream } from "effect";
import { useState } from "react";
import { Button } from "@cloudflare/kumo";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { tauriEvents } from "@/lib/events";
import { useRun } from "@/lib/run";
import { fire, invoke } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";

type SimStatus = {
  name: string;
  startMs: number;
  endMs: number;
  nowMs: number;
  speed: number;
  playing: boolean;
};

const SPEEDS = [1, 10, 60] as const;

/** `seek` is a drag, so the slider records its gesture once, on release. */
function control(action: "play" | "pause" | "seek" | "speed", value?: number) {
  if (action !== "seek") uiAction(`sim.${action}`, "agentboard", value?.toString());
  fire(invoke<void>("sim_control", { action, value: value ?? null }));
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Playback for a replayed board (`TT_SIM`) — absent when the board is live. */
export function SimBar() {
  const [sim, setSim] = useState<SimStatus | null>(null);

  useRun(
    () =>
      Effect.gen(function* () {
        const first = yield* Effect.result(invoke<SimStatus | null>("sim_status"));
        if (Result.isFailure(first) || first.success === null) return;
        setSim(first.success);
        yield* tauriEvents("sim://clock").pipe(
          Stream.runForEach((payload) => Effect.sync(() => setSim(payload as SimStatus))),
        );
      }),
    [],
  );

  if (sim === null) return null;
  const elapsedMin = Math.round((sim.nowMs - sim.startMs) / 60_000);
  return (
    <div className="flex items-center gap-2 border-b border-kumo-hairline bg-warn/10 px-3 py-1.5 text-xs">
      <span className="font-medium text-warn">SIM</span>
      <Button
        size="xs"
        variant="ghost"
        aria-label={sim.playing ? "Pause" : "Play"}
        onClick={() => control(sim.playing ? "pause" : "play")}
      >
        {sim.playing ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
      </Button>
      {SPEEDS.map((x) => (
        <Button
          key={x}
          size="xs"
          variant={sim.speed === x ? "secondary" : "ghost"}
          onClick={() => control("speed", x)}
        >
          {x}×
        </Button>
      ))}
      <input
        type="range"
        aria-label="Scenario time"
        className="min-w-0 flex-1 accent-warn"
        min={sim.startMs}
        max={sim.endMs}
        step={1000}
        value={sim.nowMs}
        onChange={(e) => control("seek", Number(e.target.value))}
        onPointerUp={() => uiAction("sim.seek", "agentboard")}
      />
      <span className="shrink-0 tabular-nums text-kumo-subtle" title={sim.name}>
        {clock(sim.nowMs)} · +{elapsedMin}m
      </span>
    </div>
  );
}
