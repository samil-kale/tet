import { refKeyOf } from "../../shared/types/project";
import type { EditorListing, EditorReport, NoticeReport } from "../../shared/types/app";
import type { ProjectRef } from "../../shared/types/project";

const MAX_NOTICES = 50;

/**
 * Control-verb data no main-process store holds: what the window reports (editor tabs, shown
 * notices). Per repository or worktree.
 */
export class ControlRecords {
  /** Per `refKey`, per editor tab, in the order first reported. */
  private readonly editorTabs = new Map<string, Map<string, EditorReport>>();
  /** Per `refKey`: the tab `editor-state` answers for. Kept past that tab's close — no
   *  report under it then, and the next activation replaces it. */
  private readonly activeEditors = new Map<string, string>();
  private readonly shownNotices: NoticeReport[] = [];

  /** null once the tab is closed. */
  setEditor(ref: ProjectRef, tabId: string, report: EditorReport | null): void {
    const refKey = refKeyOf(ref);
    const tabs = this.editorTabs.get(refKey) ?? new Map<string, EditorReport>();
    if (report) {
      tabs.set(tabId, report);
    } else {
      tabs.delete(tabId);
    }
    this.editorTabs.set(refKey, tabs);
  }

  setActiveEditor(ref: ProjectRef, tabId: string): void {
    this.activeEditors.set(refKeyOf(ref), tabId);
  }

  /** The repository's or worktree's active editor tab — `editor-state`. */
  editor(ref: ProjectRef): EditorReport | undefined {
    const refKey = refKeyOf(ref);
    const active = this.activeEditors.get(refKey);
    return active === undefined ? undefined : this.editorTabs.get(refKey)?.get(active);
  }

  /** Every open editor tab of the repository or worktree — `editor-list`. */
  editors(ref: ProjectRef): EditorListing[] {
    const refKey = refKeyOf(ref);
    const active = this.activeEditors.get(refKey);
    return [...(this.editorTabs.get(refKey) ?? [])].map(([tabId, report]) => ({ ...report, active: tabId === active }));
  }

  addNotice(report: NoticeReport): void {
    this.shownNotices.push(report);
    this.shownNotices.splice(0, this.shownNotices.length - MAX_NOTICES);
  }

  notices(): NoticeReport[] {
    return [...this.shownNotices];
  }

  /** A closed repository's or worktree's editor reports. */
  forget(ref: ProjectRef): void {
    const refKey = refKeyOf(ref);
    this.editorTabs.delete(refKey);
    this.activeEditors.delete(refKey);
  }
}
