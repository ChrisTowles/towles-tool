import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { stepMatch, type SearchMatch } from "@/lib/term-protocol";
import type { TermLink } from "@/lib/term-links";

/** What the shell-owning effect exposes to the React side of `TerminalView`. */
export type TermBridge = {
  search: (query: string) => Promise<SearchMatch[]>;
  scrollTo: (row: number) => void;
  repaint: () => void;
  focusTerm: () => void;
  copy: (markdown?: boolean) => void;
  paste: () => void;
  selectAll: () => void;
  hasSelection: () => boolean;
  clearScrollback: () => void;
  openPath: (link: Extract<TermLink, { kind: "path" }>) => void;
  linkAtPoint: (offsetX: number, offsetY: number) => TermLink | null;
  setFontSize: (px: number) => void;
};

/** Scrollback search: the query, the match cursor, and stepping through matches. */
export function useTerminalSearch(bridgeRef: RefObject<TermBridge | null>) {
  const searchRef = useRef<{ matches: SearchMatch[]; current: number }>({
    matches: [],
    current: -1,
  });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(-1);

  const runSearch = useCallback(
    async (q: string) => {
      const bridge = bridgeRef.current;
      if (!bridge) return;
      const matches = q ? await bridge.search(q) : [];
      const current = matches.length - 1; // start at the most recent match
      searchRef.current = { matches, current };
      setMatchCount(matches.length);
      setCurrentMatch(current);
      if (current >= 0) bridge.scrollTo(matches[current].row);
      bridge.repaint();
    },
    [bridgeRef],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      const sr = searchRef.current;
      const next = stepMatch(sr.matches.length, sr.current, dir);
      if (next < 0) return;
      sr.current = next;
      setCurrentMatch(next);
      bridgeRef.current?.scrollTo(sr.matches[next].row);
      bridgeRef.current?.repaint();
    },
    [bridgeRef],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
    setMatchCount(0);
    setCurrentMatch(-1);
    searchRef.current = { matches: [], current: -1 };
    bridgeRef.current?.repaint();
    bridgeRef.current?.focusTerm();
  }, [bridgeRef]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);
  // Debounced — each keystroke otherwise round-trips the engine.
  useEffect(() => {
    if (!searchOpen) return;
    const t = setTimeout(() => void runSearch(query), 150);
    return () => clearTimeout(t);
  }, [searchOpen, query, runSearch]);

  return {
    searchRef,
    searchInputRef,
    searchOpen,
    setSearchOpen,
    query,
    setQuery,
    matchCount,
    currentMatch,
    step,
    closeSearch,
  };
}
