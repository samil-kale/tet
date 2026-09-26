import { useCallback, useEffect, useRef, useState } from "react";
import type { FileSearchQuery, FileSearchResult } from "../../shared/types";
import type { Checkout } from "../checkout";

/** Typing runs the search, as VS Code's does — but only once the typing stops. */
const SEARCH_DELAY_MS = 300;

/**
 * The SEARCH pane's matches. Held by the files pane, which shows them and the search running
 * (`useFileAct` is held the same way); the field itself lives in the pane and asks for a query
 * here, or for null where it is empty.
 *
 * Held with its checkout, as the listing is: one files pane serves all, and a switch must not show
 * the previous checkout's matches. Answers are counted, not flagged — while one search is still
 * running the next has been asked for, and only the newest may be shown.
 */
export function useFileSearch(checkout: Checkout): {
  searchResult: FileSearchResult | undefined;
  searching: boolean;
  search: (query: FileSearchQuery | null) => void;
} {
  const [held, setHeld] = useState<{ key: string; result: FileSearchResult } | undefined>(undefined);
  const [searching, setSearching] = useState(false);
  const asked = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const search = useCallback(
    (query: FileSearchQuery | null) => {
      clearTimeout(timer.current);
      const seq = ++asked.current;
      if (!query) {
        setHeld(undefined);
        setSearching(false);
        return;
      }
      timer.current = setTimeout(() => {
        // Busy once the search runs, not while the typing is still awaited.
        setSearching(true);
        void window.tet.repository.searchFiles(checkout.ref, query).then((result) => {
          if (asked.current === seq) {
            setHeld({ key: checkout.key, result });
            setSearching(false);
          }
        });
      }, SEARCH_DELAY_MS);
    },
    [checkout]
  );

  return { searchResult: held?.key === checkout.key ? held.result : undefined, searching, search };
}
