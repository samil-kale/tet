import { memo } from "react";
import { LANES, type Lane } from "../../shared/types/settings";
import { IconButton } from "../ui/IconButton";
import { ArchiveIcon, FilesIcon, GearIcon, GitIcon, ProjectsIcon, type IconProps } from "../ui/icons";

/** The lane toggles' icons and labels, drawn in `LANES`' fixed order. */
const LANE_TOGGLES: Record<Lane, { noun: string; Icon: (props: IconProps) => React.ReactNode }> = {
  projects: { noun: "projects", Icon: ProjectsIcon },
  git: { noun: "git", Icon: GitIcon },
  files: { noun: "files", Icon: FilesIcon },
  archive: { noun: "archive", Icon: ArchiveIcon },
};

/** The lane toggles and settings, full height at the window's left edge (VS Code's Activity Bar);
 *  settings sits at the bottom. */
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
        const { noun, Icon } = LANE_TOGGLES[lane];
        return (
          <IconButton
            key={lane}
            active={shownLane === lane}
            onClick={() => onToggleLane(lane)}
            title={`${shownLane === lane ? "Hide" : "Show"} ${noun}`}
          >
            <Icon />
          </IconButton>
        );
      })}
      <IconButton className="activity-bar-settings" title="Show settings" onClick={onOpenSettings}>
        <GearIcon />
      </IconButton>
    </div>
  );
});
