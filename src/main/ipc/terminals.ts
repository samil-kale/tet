import { handle, on } from "./channels";
import { projectRefKey } from "../../shared/types";
import type {
  AgentId,
  ProjectRef,
  EditorReport,
  GitActionResult,
  HandoffResult,
  NoticeReport,
  TerminalDescriptor
} from "../../shared/types";
import type { IpcDeps } from "./deps";

/** The tab strip: the terminals themselves, plus what only the renderer knows about its editor
 *  tabs and shown notices. */
export function registerTerminalsIpc({
  sessions,
  records
}: Pick<IpcDeps, "sessions" | "records">): void {
  handle("terminals:list", (_event, ref: ProjectRef): TerminalDescriptor[] => {
    return sessions.get(ref)?.snapshot() ?? [];
  });

  handle("terminals:create", (_event, ref: ProjectRef, agentId: AgentId): TerminalDescriptor => {
    const manager = sessions.get(ref);
    if (!manager) {
      throw new Error(`Not open: ${projectRefKey(ref)}`);
    }
    return manager.createTab(agentId);
  });

  handle("terminals:close", async (_event, ref: ProjectRef, tabIds: string[]): Promise<void> => {
    await sessions.get(ref)?.closeTabs(tabIds);
  });

  handle(
    "terminals:rename",
    async (_event, ref: ProjectRef, tabId: string, title: string): Promise<GitActionResult> => {
      const refused = await sessions.get(ref)?.renameTab(tabId, title);
      return refused === undefined ? { ok: true } : { ok: false, error: refused };
    }
  );

  handle(
    "terminals:handoff",
    async (_event, ref: ProjectRef, tabId: string, agentId: AgentId): Promise<HandoffResult> => {
      const handed = (await sessions.get(ref)?.handOff(tabId, agentId)) ?? `Not open: ${projectRefKey(ref)}`;
      return typeof handed === "string" ? { ok: false, error: handed } : { ok: true, tab: handed };
    }
  );

  // The window's restart (the tab menu, the environment dialog): a running tab quits first.
  handle("terminals:restart", (_event, ref: ProjectRef, tabId: string): void => {
    sessions.get(ref)?.restartTab(tabId, true);
  });

  /** The tab is in front of the user: clears its finished-turn mark. Only the renderer knows. */
  on("terminals:seen", (_event, ref: ProjectRef, tabId: string) => {
    sessions.get(ref)?.markSeen(tabId);
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

  /** Tabs in front of the user get no turn toast. Only the renderer knows them. */
  on("terminals:in-front", (_event, ref: ProjectRef | null, tabIds: string[]) => {
    sessions.setInFront(ref, tabIds);
  });

  on("terminals:input", (_event, ref: ProjectRef, tabId: string, data: string) => {
    sessions.get(ref)?.write(tabId, data);
  });

  on("terminals:resize", (_event, ref: ProjectRef, tabId: string, cols: number, rows: number) => {
    sessions.get(ref)?.handleResize(tabId, cols, rows);
  });

  handle("terminals:starting", (_event, ref: ProjectRef): boolean => {
    return sessions.get(ref)?.isStarting() ?? false;
  });

}
