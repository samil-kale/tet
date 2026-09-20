import { useCallback, useEffect, useRef, useState } from "react";
import type { FileSearchQuery, FileSearchResult } from "../../shared/types";

/** Typing runs the search, as VS Code's does — but only once the typing stops. */
const SEARCH_DELAY_MS = 300;

/**
 * The Explorer search field's matches. Held by the files pane, so its one progress bar covers the
 * search too (`useFileAct` is held the same way); the field itself lives in the tree and asks for
 * a query here, or for null where it is empty.
 *
 * Held with its project, as the listing is: one files pane serves all, and a switch must not show
 * the previous project's matches. Answers are counted, not flagged — while one search is still
 * running the next has been asked for, and only the newest may be shown.
 */
export function useFileSearch(projectId: string): {
  searchResult: FileSearchResult | undefined;
  searching: boolean;
  search: (query: FileSearchQuery | null) => void;
} {
  const [held, setHeld] = useState<{ projectId: string; result: FileSearchResult } | undefined>(undefined);
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
      setSearching(true);
      timer.current = setTimeout(() => {
        void window.tet.repository.searchFiles(projectId, query).then((result) => {
          if (asked.current === seq) {
            setHeld({ projectId, result });
            setSearching(false);
          }
        });
      }, SEARCH_DELAY_MS);
    },
    [projectId]
  );

  return { searchResult: held?.projectId === projectId ? held.result : undefined, searching, search };
}
