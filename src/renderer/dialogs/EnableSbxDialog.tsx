import type { Project } from "../../shared/types";
import { useEscape } from "../ui/use-escape";

interface EnableSbxDialogProps {
  project: Project;
  /** Whether `sbx --version` succeeded — decided once, before this opens; see App's `enableSbx`. */
  installed: boolean;
  onClose: () => void;
}

/**
 * First step only: proves the open path — installed or not, this is where it shows, not a
 * notice (too easy to miss) — before any of the real configuration gets built out.
 */
export function EnableSbxDialog({ project, installed, onClose }: EnableSbxDialogProps) {
  useEscape(onClose);

  return (
    <div className="dialog-overlay">
      <div className="dialog enable-sbx-dialog">
        <div className="dialog-title">Enable sbx — {project.name}</div>
        <div className="dialog-body">
          {!installed && <p className="dialog-detail">sbx is not installed.</p>}
        </div>
        <div className="dialog-buttons">
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
