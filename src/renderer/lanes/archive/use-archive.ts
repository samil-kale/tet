import { useEffect, useState } from "react";
import { refKeyOf } from "../../../shared/types/project";
import type { TabDescriptor } from "../../../shared/types/terminals";
import type { ResolvedRef } from "../../resolved-ref";

/** The repository's or worktree's archived tabs, latest activity first, kept current as they
 *  change. Held per repository or worktree by the caller's `key`: until the answer comes, none. */
export function useArchive({ ref }: ResolvedRef): TabDescriptor[] {
  const [tabs, setTabs] = useState<TabDescriptor[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.tet.archive.list(ref).then((listed) => {
      if (!cancelled) {
        setTabs(listed);
      }
    });
    const unsubscribe = window.tet.archive.onChanged((payload) => {
      if (refKeyOf(payload.ref) === refKeyOf(ref)) {
        setTabs(payload.tabs);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [ref]);
  return tabs;
}
