import { checkoutKey } from "../../shared/types";
import type { CheckoutRef, EditorListing, EditorReport, NoticeReport } from "../../shared/types";

const MAX_NOTICES = 50;
/** As far back as `tabs-output` reaches: a long build or test log. */
const MAX_OUTPUT_CHARS = 256 * 1024;

/**
 * Control-verb data no main-process store holds: what the window reports (editor tabs, shown
 * notices) and each open tab's latest output. Per checkout.
 */
export class ControlRecords {
  /** Per checkout key, per editor tab, in the order first reported. */
  private readonly editorTabs = new Map<string, Map<string, EditorReport>>();
  /** Per checkout key: the tab `editor-state` answers for. Kept past that tab's close — no report
   *  under it then, and the next activation replaces it. */
  private readonly activeEditors = new Map<string, string>();
  private readonly shownNotices: NoticeReport[] = [];
  /** Per checkout key, per tab, what it printed, raw: cleaned only when read, so a redraw spanning
   *  chunks still collapses. */
  private readonly outputs = new Map<string, Map<string, string>>();

  /** null once the tab is closed. */
  setEditor(ref: CheckoutRef, tabId: string, report: EditorReport | null): void {
    const key = checkoutKey(ref);
    const tabs = this.editorTabs.get(key) ?? new Map<string, EditorReport>();
    if (report) {
      tabs.set(tabId, report);
    } else {
      tabs.delete(tabId);
    }
    this.editorTabs.set(key, tabs);
  }

  setActiveEditor(ref: CheckoutRef, tabId: string): void {
    this.activeEditors.set(checkoutKey(ref), tabId);
  }

  /** The checkout's active editor tab — `editor-state`. */
  editor(ref: CheckoutRef): EditorReport | undefined {
    const key = checkoutKey(ref);
    const active = this.activeEditors.get(key);
    return active === undefined ? undefined : this.editorTabs.get(key)?.get(active);
  }

  /** Every open editor tab of the checkout — `editor-list`. */
  editors(ref: CheckoutRef): EditorListing[] {
    const key = checkoutKey(ref);
    const active = this.activeEditors.get(key);
    return [...(this.editorTabs.get(key) ?? [])].map(([tabId, report]) => ({ ...report, active: tabId === active }));
  }

  addNotice(report: NoticeReport): void {
    this.shownNotices.push(report);
    this.shownNotices.splice(0, this.shownNotices.length - MAX_NOTICES);
  }

  notices(): NoticeReport[] {
    return [...this.shownNotices];
  }

  addOutput(ref: CheckoutRef, tabId: string, data: string): void {
    const key = checkoutKey(ref);
    const tabs = this.outputs.get(key) ?? new Map<string, string>();
    const text = (tabs.get(tabId) ?? "") + data;
    // Trimmed at twice the cap, to the cap when read: trimming every chunk would copy the whole
    // cap per chunk.
    tabs.set(tabId, text.length > 2 * MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text);
    this.outputs.set(key, tabs);
  }

  /** Drops what closed tabs printed, given a checkout's open tabs. */
  keepOutputs(ref: CheckoutRef, tabIds: ReadonlySet<string>): void {
    const tabs = this.outputs.get(checkoutKey(ref));
    if (!tabs) {
      return;
    }
    for (const tabId of tabs.keys()) {
      if (!tabIds.has(tabId)) {
        tabs.delete(tabId);
      }
    }
  }

  /** A closed checkout's editor reports and tab output. */
  forget(ref: CheckoutRef): void {
    const key = checkoutKey(ref);
    this.editorTabs.delete(key);
    this.activeEditors.delete(key);
    this.outputs.delete(key);
  }

  /** Raw, escape sequences included; undefined before any output. */
  output(ref: CheckoutRef, tabId: string): string | undefined {
    return this.outputs.get(checkoutKey(ref))?.get(tabId)?.slice(-MAX_OUTPUT_CHARS);
  }
}
