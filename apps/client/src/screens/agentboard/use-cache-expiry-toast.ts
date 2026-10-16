import { useEffect, useRef } from "react";
import { fmtMins } from "@/components/agentboard-bits/session-badges";
import { isCacheExpiring } from "@/lib/agentboard/context";
import { isAgent } from "@/lib/agentboard/session";
import type { RepoData } from "@/lib/agentboard/types";
import { toast } from "@/lib/toast";

/** One-shot "prompt cache about to expire" toast per session per cache generation. */
export function useCacheExpiryToast(repos: RepoData[], now: number) {
  const cacheWarned = useRef(new Set<string>());
  useEffect(() => {
    for (const repo of repos)
      for (const folder of repo.folders)
        for (const s of folder.sessions) {
          const d = s.agentState?.details;
          if (!s.live || !isAgent(s) || !d?.cacheExpiresAt) continue;
          if (!isCacheExpiring(d, now)) continue;
          const key = `${s.id}:${d.cacheExpiresAt}`;
          if (cacheWarned.current.has(key)) continue;
          cacheWarned.current.add(key);
          toast(
            `◔ ${folder.name} / ${s.name} — prompt cache expires in ~${fmtMins(d.cacheExpiresAt - now)}. Any message re-warms it; a cold resume re-reads everything at full price.`,
          );
        }
  }, [repos, now]);
}
