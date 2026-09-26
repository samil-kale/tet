import { ipcMain } from "electron";
import { checkoutKey } from "../../shared/types";
import type { AgentId, CheckoutRef, EditorReport, GitActionResult, NoticeReport, TerminalDescriptor } from "../../shared/types";
import { countActivity } from "../event-loop-monitor";
import type { IpcDeps } from "./deps";

/** The tab strip: the terminals themselves, plus what only the renderer knows about its editor
 *  tabs and shown notices. */
export function registerTerminalsIpc({
  sessions,
  records
}: Pick<IpcDeps, "sessions" | "records">): void {
  ipcMain.handle("terminals:list", (_event, checkout: CheckoutRef): TerminalDescriptor[] => {
    return sessions.get(checkout)?.snapshot() ?? [];
  });

  ipcMain.handle("terminals:create", (_event, checkout: CheckoutRef, agentId: AgentId): TerminalDescriptor => {
    const manager = sessions.get(checkout);
    if (!manager) {
      throw new Error(`Unknown checkout: ${checkoutKey(checkout)}`);
    }
    return manager.createTab(agentId);
  });

  ipcMain.handle("terminals:close", async (_event, checkout: CheckoutRef, tabIds: string[]): Promise<void> => {
    await sessions.get(checkout)?.closeTabs(tabIds);
  });

  ipcMain.handle(
    "terminals:rename",
    async (_event, checkout: CheckoutRef, tabId: string, title: string): Promise<GitActionResult> => {
      const refused = await sessions.get(checkout)?.renameTab(tabId, title);
      return refused === undefined ? { ok: true } : { ok: false, error: refused };
    }
  );

  // The tab menu offers it only for a tab with no process; the environment dialog for a running one.
  ipcMain.handle("terminals:restart", (_event, checkout: CheckoutRef, tabId: string): void => {
    sessions.get(checkout)?.restartTab(tabId, true);
  });

  /** The tab is in front of the user: clears its finished-turn mark. Only the renderer knows. */
  ipcMain.on("terminals:seen", (_event, checkout: CheckoutRef, tabId: string) => {
    sessions.get(checkout)?.markSeen(tabId);
  });

  /** The editor tabs and shown notices, for tet-ctl — only the renderer knows. */
  ipcMain.on("editor:report", (_event, checkout: CheckoutRef, tabId: string, report: EditorReport | null) => {
    records.setEditor(checkout, tabId, report);
  });
  ipcMain.on("editor:active", (_event, checkout: CheckoutRef, tabId: string) => {
    records.setActiveEditor(checkout, tabId);
  });

  ipcMain.on("app:notice-shown", (_event, report: NoticeReport) => {
    records.addNotice(report);
  });

  /** Tabs in front of the user get no turn toast. Only the renderer knows them. */
  ipcMain.on("terminals:in-front", (_event, checkout: CheckoutRef | null, tabIds: string[]) => {
    sessions.setInFront(checkout, tabIds);
  });

  ipcMain.on("terminals:input", (_event, checkout: CheckoutRef, tabId: string, data: string) => {
    countActivity("input");
    sessions.get(checkout)?.write(tabId, data);
  });

  ipcMain.on("terminals:resize", (_event, checkout: CheckoutRef, tabId: string, cols: number, rows: number) => {
    sessions.get(checkout)?.handleResize(tabId, cols, rows);
  });

  ipcMain.handle("terminals:starting", (_event, checkout: CheckoutRef): boolean => {
    return sessions.get(checkout)?.isStarting() ?? false;
  });

  ipcMain.handle("terminals:resolve-url", async (_event, checkout: CheckoutRef, tabId: string, fragment: string) => {
    return (await sessions.get(checkout)?.resolveUrlPrefix(tabId, fragment)) ?? null;
  });
}
