import { useEffect } from "react";
import { noticePlace } from "../../shared/types/app";
import { isWorking } from "../../shared/types/terminals";
import type { TabDescriptor } from "../../shared/types/terminals";
import type { ResolvedRef } from "../resolved-ref";
import { syncWorkingNotices } from "../ui/Notices";
import { agentName, useAgents } from "../ui/use-agents";

/**
 * Lists every working session (`isWorking`) in the notification center, worded as a turn's
 * notification is (`notificationFor`): the agent's name, then the repository or worktree and the
 * tab's title.
 */
export function useWorkingNotices(tabs: Record<string, TabDescriptor[]>, resolvedRefs: Record<string, ResolvedRef>): void {
  const agents = useAgents();
  useEffect(() => {
    const working = Object.entries(tabs).flatMap(([refKey, refTabs]) => {
      const resolved = resolvedRefs[refKey];
      if (!resolved) {
        return [];
      }
      return refTabs.filter(isWorking).map((tab) => ({
        target: { ref: resolved.ref, tabId: tab.tabId },
        title: `Working [${agentName(agents, tab.agentId)}]`,
        message: noticePlace(resolved.name, tab.title),
      }));
    });
    syncWorkingNotices(working);
  }, [tabs, resolvedRefs, agents]);
}
