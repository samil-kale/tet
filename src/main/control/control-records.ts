import type { EditorListing, EditorReport, NoticeReport } from "../../shared/types";

const MAX_NOTICES = 50;
/** As far back as `tabs-output` reaches: a long build or test log. */
const MAX_OUTPUT_CHARS = 256 * 1024;

/**
 * Control-verb data no main-process store holds: what the window reports (editor tabs, shown
 * notices) and each open tab's latest output.
 */
export class ControlRecords {
  /** Per project, per editor tab, in the order first reported. */
  private readonly editorTabs = new Map<string, Map<string, EditorReport>>();
  /** Per project: the tab `editor-state` answers for. Kept past that tab's close — no report
   *  under it then, and the next activation replaces it. */
  private readonly activeEditors = new Map<string, string>();
  private readonly shownNotices: NoticeReport[] = [];
  /** Per project, per tab, what it printed, raw: cleaned only when read, so a redraw spanning
   *  chunks still collapses. */
  private readonly outputs = new Map<string, Map<string, string>>();

  /** null once the tab is closed. */
  setEditor(projectId: string, tabId: string, report: EditorReport | null): void {
    const tabs = this.editorTabs.get(projectId) ?? new Map<string, EditorReport>();
    if (report) {
      tabs.set(tabId, report);
    } else {
      tabs.delete(tabId);
    }
    this.editorTabs.set(projectId, tabs);
  }

  setActiveEditor(projectId: string, tabId: string): void {
    this.activeEditors.set(projectId, tabId);
  }

  /** The project's active editor tab — `editor-state`. */
  editor(projectId: string): EditorReport | undefined {
    const active = this.activeEditors.get(projectId);
    return active === undefined ? undefined : this.editorTabs.get(projectId)?.get(active);
  }

  /** Every open editor tab of the project — `editor-list`. */
  editors(projectId: string): EditorListing[] {
    const active = this.activeEditors.get(projectId);
    return [...(this.editorTabs.get(projectId) ?? [])].map(([tabId, report]) => ({ ...report, active: tabId === active }));
  }

  addNotice(report: NoticeReport): void {
    this.shownNotices.push(report);
    this.shownNotices.splice(0, this.shownNotices.length - MAX_NOTICES);
  }

  notices(): NoticeReport[] {
    return [...this.shownNotices];
  }

  addOutput(projectId: string, tabId: string, data: string): void {
    const tabs = this.outputs.get(projectId) ?? new Map<string, string>();
    const text = (tabs.get(tabId) ?? "") + data;
    // Trimmed at twice the cap, to the cap when read: trimming every chunk would copy the whole
    // cap per chunk.
    tabs.set(tabId, text.length > 2 * MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text);
    this.outputs.set(projectId, tabs);
  }

  /** Drops what closed tabs printed, given a project's open tabs. */
  keepOutputs(projectId: string, tabIds: ReadonlySet<string>): void {
    const tabs = this.outputs.get(projectId);
    if (!tabs) {
      return;
    }
    for (const tabId of tabs.keys()) {
      if (!tabIds.has(tabId)) {
        tabs.delete(tabId);
      }
    }
  }

  /** A removed project's editor reports and tab output. */
  forgetProject(projectId: string): void {
    this.editorTabs.delete(projectId);
    this.activeEditors.delete(projectId);
    this.outputs.delete(projectId);
  }

  /** Raw, escape sequences included; undefined before any output. */
  output(projectId: string, tabId: string): string | undefined {
    return this.outputs.get(projectId)?.get(tabId)?.slice(-MAX_OUTPUT_CHARS);
  }
}
