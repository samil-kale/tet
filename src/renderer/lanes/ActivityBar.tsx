import { memo } from "react";
import { LANES, type Lane } from "../../shared/types/settings";
import { shortcutLabel, type ShortcutId } from "../shortcuts";
import { IconButton } from "../ui/IconButton";
import { ArchiveIcon, FilesIcon, GearIcon, GitIcon, ProjectsIcon, type IconProps } from "../ui/icons";

/** The lane toggles' icons and labels, drawn in `LANES`' fixed order. */
const LANE_TOGGLES: Record<Lane, { title: string; shortcut?: ShortcutId; Icon: (props: IconProps) => React.ReactNode }> = {
  projects: { title: "Projects", shortcut: "toggleProjects", Icon: ProjectsIcon },
  git: { title: "Git", shortcut: "toggleGit", Icon: GitIcon },
  files: { title: "Files", shortcut: "toggleFiles", Icon: FilesIcon },
  archive: { title: "Archive", shortcut: "toggleArchive", Icon: ArchiveIcon },
};

/** The lane toggles and settings, full height at the window's left edge (VS Code's Activity Bar);
 *  settings sits right after the lane toggles. */
export const ActivityBar = memo(function ActivityBar({
  shownLane,
  onToggleLane,
  onOpenSettings,
}: {
  shownLane: Lane | null;
  onToggleLane: (lane: Lane) => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="activity-bar">
      {LANES.map((lane) => {
        const { title, shortcut, Icon } = LANE_TOGGLES[lane];
        return (
          <IconButton
            key={lane}
            active={shownLane === lane}
            onClick={() => onToggleLane(lane)}
            title={shortcut ? `${title} (${shortcutLabel(shortcut)})` : title}
          >
            <Icon />
          </IconButton>
        );
      })}
      <IconButton title={`Settings (${shortcutLabel("settings")})`} onClick={onOpenSettings}>
        <GearIcon />
      </IconButton>
    </div>
  );
});
