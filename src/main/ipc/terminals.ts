import { handle, on } from "./channels";
import { projectRefKey } from "../../shared/types/project";
import type { AgentId } from "../../shared/types/agents";
import type { EditorReport, NoticeReport } from "../../shared/types/app";
import type { GitActionResult } from "../../shared/types/git";
import type { ProjectRef } from "../../shared/types/project";
import type { HandoffResult, TabDescriptor } from "../../shared/types/terminals";
import type { IpcDeps } from "./deps";

/** The tab strip: the terminals themselves, plus what only the renderer knows about its editor
 *  tabs and shown notices. */
export function registerTerminalsIpc({
  tabManagers,
  records
}: Pick<IpcDeps, "tabManagers" | "records">): void {
  handle("terminals:list", (_event, ref: ProjectRef): TabDescriptor[] => {
    return tabManagers.get(ref)?.snapshot() ?? [];
  });

  handle("terminals:create", (_event, ref: ProjectRef, agentId: AgentId): TabDescriptor => {
    const manager = tabManagers.get(ref);
    if (!manager) {
      throw new Error(`Not open: ${projectRefKey(ref)}`);
    }
    return manager.createTab(agentId);
  });

  handle("terminals:close", async (_event, ref: ProjectRef, tabIds: string[]): Promise<void> => {
    await tabManagers.get(ref)?.closeTabs(tabIds);
  });

  handle(
    "terminals:rename",
    async (_event, ref: ProjectRef, tabId: string, title: string): Promise<GitActionResult> => {
      const refused = await tabManagers.get(ref)?.renameTab(tabId, title);
      return refused === undefined ? { ok: true } : { ok: false, error: refused };
    }
  );

  handle(
    "terminals:handoff",
    async (_event, ref: ProjectRef, tabId: string, agentId: AgentId): Promise<HandoffResult> => {
      const handed = (await tabManagers.get(ref)?.handOff(tabId, agentId)) ?? `Not open: ${projectRefKey(ref)}`;
      return typeof handed === "string" ? { ok: false, error: handed } : { ok: true, tab: handed };
    }
  );

  // The window's restart (the tab menu, the environment dialog): a running tab quits first.
  handle("terminals:restart", (_event, ref: ProjectRef, tabId: string): void => {
    tabManagers.get(ref)?.restartTab(tabId, true);
  });

  /** The tab is in front of the user: clears its finished-turn mark. Only the renderer knows. */
  on("terminals:seen", (_event, ref: ProjectRef, tabId: string) => {
    tabManagers.get(ref)?.markSeen(tabId);
  });

  /** The editor tabs and shown notices, for tet-ctl — only the renderer knows. */
  on("editor:report", (_event, ref: ProjectRef, tabId: string, report: EditorReport | null) => {
    records.setEditor(ref, tabId, report);
  });
  on("editor:active", (_event, ref: ProjectRef, tabId: string) => {
    records.setActiveEditor(ref, tabId);
  });

  on("app:notice-shown", (_event, report: NoticeReport) => {
    records.addNotice(report);
  });

  /** Tabs in front of the user get no turn notification. Only the renderer knows them. */
  on("terminals:in-front", (_event, ref: ProjectRef | null, tabIds: string[]) => {
    tabManagers.setInFront(ref, tabIds);
  });

  on("terminals:input", (_event, ref: ProjectRef, tabId: string, data: string) => {
    tabManagers.get(ref)?.write(tabId, data);
  });

  on("terminals:resize", (_event, ref: ProjectRef, tabId: string, cols: number, rows: number) => {
    tabManagers.get(ref)?.handleResize(tabId, cols, rows);
  });

  handle("terminals:starting", (_event, ref: ProjectRef): boolean => {
    return tabManagers.get(ref)?.isStarting() ?? false;
  });

}
