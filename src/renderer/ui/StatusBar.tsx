import { memo, useCallback, useEffect, useState } from "react";
import type { AgentId, AgentInfo } from "../../shared/types/agents";
import type { Project } from "../../shared/types/project";
import { shortcutLabel } from "../shortcuts";
import { agentEntry } from "./agent-icons";
import { ArchiveIcon, BellIcon, BranchIcon, ProjectsIcon, SquareTerminalIcon } from "./icons";
import { CLOSE_MS, MARK_ORDER, removable, toggleCenter, useNoticeList } from "./Notices";
import { StatusList, type StatusListItem } from "./StatusList";
import { TabMark } from "./TabMark";

/** What the tabs' button and list say while there is no tab to name. */
const NO_TABS = "No tabs open";

type ListName = "projects" | "tabs" | "branches" | "archive";

interface StatusBarProps {
  /** The active repository's or worktree's project; absent while none is open. */
  project: Project | undefined;
  /** Every project, as its click lists them. */
  projects: StatusListItem[];
  /** A project's click in that list opens its repository. */
  onSelectProject: (projectId: string) => void;
  /** Its tabs in the strip's order. */
  tabs: StatusListItem[];
  /** The tab the focused pane shows; absent while it has none. */
  activeTabId: string | undefined;
  /** A tab's click shows it. */
  onSelectTab: (tabId: string) => void;
  /** What the tabs' list's plus offers. */
  agents: AgentInfo[];
  /** An agent's click in that plus's menu opens a tab of it. */
  onNewTab: (agentId: AgentId) => void;
  /** Its branch, or the short commit id while detached; absent while none is open. */
  branch: string | undefined;
  /** Its uncommitted changes, by the branch. */
  changesCount: number;
  /** Its archived sessions, as the archive's click lists them. */
  archived: StatusListItem[];
  /** An archived session's click in that list reopens its tab. */
  onSelectArchived: (tabId: string) => void;
  /** Its local branches in the branch tree's order, as the branch's click lists them. */
  branches: StatusListItem[];
  /** A branch's click in that list switches to it. */
  onSelectBranch: (name: string) => void;
}

/** The window's bottom edge (VS Code's status bar): the active repository or worktree with its active
 *  tab, whose clicks list the projects and the tabs to pick from, and its branch with its change
 *  count, whose click lists the local branches; at the right edge the button of the notification
 *  center. Its icons read smaller than the rest of the app's. */
export const StatusBar = memo(function StatusBar({
  project,
  projects,
  onSelectProject,
  tabs,
  activeTabId,
  onSelectTab,
  agents,
  onNewTab,
  branch,
  changesCount,
  archived,
  onSelectArchived,
  branches,
  onSelectBranch,
}: StatusBarProps) {
  const notices = useNoticeList();
  /** The list shown, if any: one at a time, as they share their place. */
  const [openList, setOpenList] = useState<ListName | null>(null);
  /** It is fading out, closed once it has, as the notification center does. */
  const [closing, setClosing] = useState(false);
  const closeList = useCallback(() => setClosing(true), []);
  const toggleList = (list: ListName): void => {
    if (openList === list) {
      closeList();
    } else {
      setOpenList(list);
      setClosing(false);
    }
  };
  useEffect(() => {
    if (!closing) {
      return;
    }
    const timer = setTimeout(() => {
      setOpenList(null);
      setClosing(false);
    }, CLOSE_MS);
    return () => clearTimeout(timer);
  }, [closing]);
  // The list closes, as on a click on one of its entries.
  const newTabEntries = useCallback(
    () =>
      agents.map((agent) =>
        agentEntry(agent, () => {
          closeList();
          onNewTab(agent.id);
        }),
      ),
    [agents, closeList, onNewTab],
  );
  const active = tabs.find((tab) => tab.id === activeTabId);
  // An agent's notice stands in the center until its tab's state ends, read or not.
  const highlighted = notices.some((notice) => !notice.read || !removable(notice));
  const marks = MARK_ORDER.filter((mark) => notices.some((notice) => notice.mark === mark));
  return (
    <>
      <div className="status-bar">
        {project && (
          <button type="button" className="status-bar-item status-bar-projects" title="Projects" onClick={() => toggleList("projects")}>
            <ProjectsIcon className="tree-icon" />
            {project.name}
          </button>
        )}
        <button type="button" className="status-bar-item status-bar-tabs" title="Tabs" onClick={() => toggleList("tabs")}>
          {active?.icon ?? <SquareTerminalIcon className="tree-icon" />}
          <span className="status-bar-tab">{active?.label ?? NO_TABS}</span>
        </button>
        {branch && (
          <button type="button" className="status-bar-item status-bar-branches" title="Branches" onClick={() => toggleList("branches")}>
            <BranchIcon className="tree-icon" />
            {branch}: {changesCount}
          </button>
        )}
        {project && (
          <button type="button" className="status-bar-item status-bar-archive" title="Archive" onClick={() => toggleList("archive")}>
            <ArchiveIcon className="tree-icon" />
            archive: {archived.length}
          </button>
        )}
        <button
          type="button"
          className={`status-bar-item status-bar-notices${highlighted ? " highlighted" : ""}`}
          title={`Notifications (${shortcutLabel("toggleNotices")})`}
          onClick={toggleCenter}
        >
          {marks.map((mark) => (
            <TabMark key={mark} kind={mark} />
          ))}
          <BellIcon className="tree-icon" />
        </button>
      </div>
      {openList === "projects" && (
        <StatusList
          title="Projects"
          items={projects}
          activeId={project?.id}
          trigger="status-bar-projects"
          onSelect={onSelectProject}
          closing={closing}
          onClose={closeList}
        />
      )}
      {openList === "tabs" && (
        <StatusList
          title="Tabs"
          items={tabs}
          activeId={activeTabId}
          trigger="status-bar-tabs"
          onSelect={onSelectTab}
          closing={closing}
          onClose={closeList}
          // Without a project there is nowhere to open a tab.
          newTabEntries={project ? newTabEntries : undefined}
          emptyText={NO_TABS}
          sorted
        />
      )}
      {openList === "archive" && (
        <StatusList
          title="Archive"
          items={archived}
          activeId={undefined}
          trigger="status-bar-archive"
          onSelect={onSelectArchived}
          closing={closing}
          onClose={closeList}
          emptyText="No archived sessions"
        />
      )}
      {openList === "branches" && (
        <StatusList
          title="Branches"
          items={branches}
          activeId={branch}
          trigger="status-bar-branches"
          onSelect={onSelectBranch}
          closing={closing}
          onClose={closeList}
        />
      )}
    </>
  );
});
