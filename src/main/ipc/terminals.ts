import { ipcMain } from "electron";
import { projectRefKey } from "../../shared/types";
import type { AgentId, ProjectRef, EditorReport, GitActionResult, NoticeReport, TerminalDescriptor } from "../../shared/types";
import { countActivity } from "../event-loop-monitor";
import type { IpcDeps } from "./deps";

/** The tab strip: the terminals themselves, plus what only the renderer knows about its editor
 *  tabs and shown notices. */
export function registerTerminalsIpc({
  sessions,
  records
}: Pick<IpcDeps, "sessions" | "records">): void {
  ipcMain.handle("terminals:list", (_event, ref: ProjectRef): TerminalDescriptor[] => {
    return sessions.get(ref)?.snapshot() ?? [];
  });

  ipcMain.handle("terminals:create", (_event, ref: ProjectRef, agentId: AgentId): TerminalDescriptor => {
    const manager = sessions.get(ref);
    if (!manager) {
      throw new Error(`Not open: ${projectRefKey(ref)}`);
    }
    return manager.createTab(agentId);
  });

  ipcMain.handle("terminals:close", async (_event, ref: ProjectRef, tabIds: string[]): Promise<void> => {
    await sessions.get(ref)?.closeTabs(tabIds);
  });

  ipcMain.handle(
    "terminals:rename",
    async (_event, ref: ProjectRef, tabId: string, title: string): Promise<GitActionResult> => {
      const refused = await sessions.get(ref)?.renameTab(tabId, title);
      return refused === undefined ? { ok: true } : { ok: false, error: refused };
    }
  );

  // The tab menu offers it only for a tab with no process; the environment dialog for a running one.
  ipcMain.handle("terminals:restart", (_event, ref: ProjectRef, tabId: string): void => {
    sessions.get(ref)?.restartTab(tabId, true);
  });

  /** The tab is in front of the user: clears its finished-turn mark. Only the renderer knows. */
  ipcMain.on("terminals:seen", (_event, ref: ProjectRef, tabId: string) => {
    sessions.get(ref)?.markSeen(tabId);
  });

  /** The editor tabs and shown notices, for tet-ctl — only the renderer knows. */
  ipcMain.on("editor:report", (_event, ref: ProjectRef, tabId: string, report: EditorReport | null) => {
    records.setEditor(ref, tabId, report);
  });
  ipcMain.on("editor:active", (_event, ref: ProjectRef, tabId: string) => {
    records.setActiveEditor(ref, tabId);
  });

  ipcMain.on("app:notice-shown", (_event, report: NoticeReport) => {
    records.addNotice(report);
  });

  /** Tabs in front of the user get no turn toast. Only the renderer knows them. */
  ipcMain.on("terminals:in-front", (_event, ref: ProjectRef | null, tabIds: string[]) => {
    sessions.setInFront(ref, tabIds);
  });

  ipcMain.on("terminals:input", (_event, ref: ProjectRef, tabId: string, data: string) => {
    countActivity("input");
    sessions.get(ref)?.write(tabId, data);
  });

  ipcMain.on("terminals:resize", (_event, ref: ProjectRef, tabId: string, cols: number, rows: number) => {
    sessions.get(ref)?.handleResize(tabId, cols, rows);
  });

  ipcMain.handle("terminals:starting", (_event, ref: ProjectRef): boolean => {
    return sessions.get(ref)?.isStarting() ?? false;
  });

  ipcMain.handle("terminals:resolve-url", async (_event, ref: ProjectRef, tabId: string, fragment: string) => {
    return (await sessions.get(ref)?.resolveUrlPrefix(tabId, fragment)) ?? null;
  });
}
