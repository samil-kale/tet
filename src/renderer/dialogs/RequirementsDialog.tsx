import type { Requirement, Requirements } from "../../shared/types";
import { DialogFrame } from "../ui/DialogFrame";

/** The command to try in a terminal on the left, what the check found on the right. */
function RequirementRow({ requirement }: { requirement: Requirement }) {
  return (
    <div className="requirement-item">
      <span className="requirement-command">{requirement.command}</span>
      <span className={requirement.installed ? "requirement-state found" : "requirement-state"}>
        {requirement.installed ? "Installed" : "Missing"}
      </span>
    </div>
  );
}

interface RequirementsDialogProps {
  requirements: Requirements;
  /** A check is running; the button spins meanwhile. */
  checking: boolean;
  onRecheck: () => void;
}

/** What is missing. Not in Dialog.tsx: a wall, not a question — it stands until the programs are
 *  there, with no Escape. Installs nothing: no command works on all three platforms. */
export function RequirementsDialog({ requirements, checking, onRecheck }: RequirementsDialogProps) {
  return (
    <DialogFrame
      // No close button: nothing stands behind this yet.
      header={{ title: "Missing requirements" }}
      className="requirements-dialog"
      busy={checking}
      buttons={
        <>
          <button type="button" className="button secondary" onClick={() => window.tet.startup.quit()}>
            Quit
          </button>
          <button type="button" className="button" onClick={onRecheck} disabled={checking}>
            Check again
          </button>
        </>
      }
    >
      <p className="dialog-message">Git is required:</p>
      <div className="requirement-list">
        <RequirementRow requirement={requirements.git} />
      </div>
      <p className="dialog-message">At least one agent or sbx:</p>
      <div className="requirement-list">
        {requirements.agents.map((agent) => (
          <RequirementRow key={agent.name} requirement={agent} />
        ))}
        <RequirementRow requirement={requirements.sbx} />
      </div>
      <p className="dialog-message">Install what is missing, then check again.</p>
    </DialogFrame>
  );
}
