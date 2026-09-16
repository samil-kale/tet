import type { AgentId, EditorReport, NoticeReport } from "../../shared/types";

const MAX_NOTICES = 50;
/** A few screens of a TUI's redraws. */
const MAX_OUTPUT_CHARS = 64 * 1024;

/**
 * Control-verb data no main-process store holds: what the window reports (editor tab, shown
 * notices) and each agent tab's latest output. A shell tab's lines are ShellContext's.
 */
export class ControlRecords {
  private readonly editors = new Map<string, EditorReport>();
  private readonly shownNotices: NoticeReport[] = [];
  private readonly outputs = new Map<string, string>();

  /** null once the editor tab is closed. */
  setEditor(projectId: string, report: EditorReport | null): void {
    if (report) {
      this.editors.set(projectId, report);
    } else {
      this.editors.delete(projectId);
    }
  }

  editor(projectId: string): EditorReport | undefined {
    return this.editors.get(projectId);
  }

  addNotice(report: NoticeReport): void {
    this.shownNotices.push(report);
    this.shownNotices.splice(0, this.shownNotices.length - MAX_NOTICES);
  }

  notices(): NoticeReport[] {
    return [...this.shownNotices];
  }

  addOutput(projectId: string, tabId: string, agentId: AgentId, data: string): void {
    if (agentId === "shell") {
      return;
    }
    const key = `${projectId}\u0000${tabId}`;
    this.outputs.set(key, ((this.outputs.get(key) ?? "") + data).slice(-MAX_OUTPUT_CHARS));
  }

  /** Undefined before any output, and for a shell tab. */
  output(projectId: string, tabId: string): string | undefined {
    return this.outputs.get(`${projectId}\u0000${tabId}`);
  }
}
