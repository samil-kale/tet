import { memo } from "react";
import { LANES, type Lane } from "../../shared/types/settings";
import { IconButton } from "../ui/IconButton";
import { ArchiveIcon, FilesIcon, GearIcon, GitIcon, ProjectsIcon, type IconProps } from "../ui/icons";

/** The lane toggles' icons and labels, drawn in `LANES`' fixed order. */
const LANE_TOGGLES: Record<Lane, { title: string; Icon: (props: IconProps) => React.ReactNode }> = {
  projects: { title: "Projects", Icon: ProjectsIcon },
  git: { title: "Git", Icon: GitIcon },
  files: { title: "Files", Icon: FilesIcon },
  archive: { title: "Archive", Icon: ArchiveIcon },
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
        const { title, Icon } = LANE_TOGGLES[lane];
        return (
          <IconButton key={lane} active={shownLane === lane} onClick={() => onToggleLane(lane)} title={title}>
            <Icon />
          </IconButton>
        );
      })}
      <IconButton title="Settings" onClick={onOpenSettings}>
        <GearIcon />
      </IconButton>
    </div>
  );
});
