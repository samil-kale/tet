import type { AgentId, EditorReport, NoticeReport } from "../../shared/types";

const MAX_NOTICES = 50;
/** A few screens of a TUI's redraws. */
const MAX_AGENT_OUTPUT_CHARS = 64 * 1024;
/** Thousands of a shell's lines — as far back as `tabs-shell-output` reaches. */
const MAX_SHELL_OUTPUT_CHARS = 1024 * 1024;

/** What a tab printed, raw: cleaned only when read, so a redraw spanning chunks still collapses. */
interface TabOutput {
  text: string;
  shell: boolean;
}

function capOf(output: TabOutput): number {
  return output.shell ? MAX_SHELL_OUTPUT_CHARS : MAX_AGENT_OUTPUT_CHARS;
}

/** The latest of a tab's output within its cap. A shell's first line cut by the cap is dropped,
 *  since it would read as a whole one; a TUI's redraws have no lines to keep whole. */
function capped(output: TabOutput): string {
  const max = capOf(output);
  if (output.text.length <= max) {
    return output.text;
  }
  const text = output.text.slice(-max);
  return output.shell ? text.slice(text.indexOf("\n") + 1) : text;
}

/**
 * Control-verb data no main-process store holds: what the window reports (editor tab, shown
 * notices) and each open tab's latest output.
 */
export class ControlRecords {
  private readonly editors = new Map<string, EditorReport>();
  private readonly shownNotices: NoticeReport[] = [];
  /** Per project, per tab. */
  private readonly outputs = new Map<string, Map<string, TabOutput>>();

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
    const tabs = this.outputs.get(projectId) ?? new Map<string, TabOutput>();
    const output = tabs.get(tabId) ?? { text: "", shell: agentId === "shell" };
    output.text += data;
    // Trimmed at twice the cap, to the cap when read: trimming every chunk would copy up to a
    // megabyte per chunk.
    if (output.text.length > 2 * capOf(output)) {
      output.text = capped(output);
    }
    tabs.set(tabId, output);
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

  /** A removed project's editor report and tab output. */
  forgetProject(projectId: string): void {
    this.editors.delete(projectId);
    this.outputs.delete(projectId);
  }

  /** Raw, escape sequences included; undefined before any output. */
  output(projectId: string, tabId: string): string | undefined {
    const output = this.outputs.get(projectId)?.get(tabId);
    return output && capped(output);
  }
}
