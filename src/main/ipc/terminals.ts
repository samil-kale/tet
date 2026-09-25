import { ipcMain } from "electron";
import type { AgentId, EditorReport, GitActionResult, NoticeReport, TerminalDescriptor } from "../../shared/types";
import { countActivity } from "../event-loop-monitor";
import type { IpcDeps } from "./deps";

/** The tab strip: the terminals themselves, plus what only the renderer knows about its editor
 *  tabs and shown notices. */
export function registerTerminalsIpc({
  sessions,
  records
}: Pick<IpcDeps, "sessions" | "records">): void {
  ipcMain.handle("terminals:list", (_event, projectId: string): TerminalDescriptor[] => {
    return sessions.get(projectId)?.snapshot() ?? [];
  });

  ipcMain.handle("terminals:create", (_event, projectId: string, agentId: AgentId): TerminalDescriptor => {
    const manager = sessions.get(projectId);
    if (!manager) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    return manager.createTab(agentId);
  });

  ipcMain.handle("terminals:close", async (_event, projectId: string, tabIds: string[]): Promise<void> => {
    await sessions.get(projectId)?.closeTabs(tabIds);
  });

  ipcMain.handle(
    "terminals:rename",
    async (_event, projectId: string, tabId: string, title: string): Promise<GitActionResult> => {
      const refused = await sessions.get(projectId)?.renameTab(tabId, title);
      return refused === undefined ? { ok: true } : { ok: false, error: refused };
    }
  );

  // The tab menu offers it only for a tab with no process; the environment dialog for a running one.
  ipcMain.handle("terminals:restart", (_event, projectId: string, tabId: string): void => {
    sessions.get(projectId)?.restartTab(tabId, true);
  });

  /** The tab is in front of the user: clears its finished-turn mark. Only the renderer knows. */
  ipcMain.on("terminals:seen", (_event, projectId: string, tabId: string) => {
    sessions.get(projectId)?.markSeen(tabId);
  });

  /** The editor tabs and shown notices, for tet-ctl — only the renderer knows. */
  ipcMain.on("editor:report", (_event, projectId: string, tabId: string, report: EditorReport | null) => {
    records.setEditor(projectId, tabId, report);
  });
  ipcMain.on("editor:active", (_event, projectId: string, tabId: string) => {
    records.setActiveEditor(projectId, tabId);
  });

  ipcMain.on("app:notice-shown", (_event, report: NoticeReport) => {
    records.addNotice(report);
  });

  /** Tabs in front of the user get no turn toast. Only the renderer knows them. */
  ipcMain.on("terminals:in-front", (_event, projectId: string | null, tabIds: string[]) => {
    sessions.setInFront(projectId, tabIds);
  });

  ipcMain.on("terminals:input", (_event, projectId: string, tabId: string, data: string) => {
    countActivity("input");
    sessions.get(projectId)?.write(tabId, data);
  });

  ipcMain.on("terminals:resize", (_event, projectId: string, tabId: string, cols: number, rows: number) => {
    sessions.get(projectId)?.handleResize(tabId, cols, rows);
  });

  ipcMain.handle("terminals:starting", (_event, projectId: string): boolean => {
    return sessions.get(projectId)?.isStarting() ?? false;
  });

  ipcMain.handle("terminals:resolve-url", async (_event, projectId: string, tabId: string, fragment: string) => {
    return (await sessions.get(projectId)?.resolveUrlPrefix(tabId, fragment)) ?? null;
  });
}
