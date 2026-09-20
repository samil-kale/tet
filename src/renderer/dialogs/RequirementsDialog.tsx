import type { Requirement, Requirements } from "../../shared/types";
import { DialogFrame } from "../ui/DialogFrame";
import { SpinnerIcon } from "../ui/icons";

/** Name on the left, what the check found on the right. */
function RequirementRow({ requirement }: { requirement: Requirement }) {
  return (
    <div className="requirement-item">
      <span className="requirement-name">{requirement.name}</span>
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
      header={{ title: "TET cannot start" }}
      className="requirements-dialog"
      buttons={
        <>
          <button type="button" className="button secondary" onClick={() => window.tet.startup.quit()}>
            Quit
          </button>
          <button type="button" className="button" onClick={onRecheck} disabled={checking}>
            {checking && <SpinnerIcon className="spinning" />}
            <span>Check again</span>
          </button>
        </>
      }
    >
      <p className="dialog-message">
        Git runs the whole git side, and an agent is what the terminals are for — on this machine
        or in a sandbox. Install what is missing, then check again.
      </p>
      <div className="requirement-list">
        <RequirementRow requirement={requirements.git} />
      </div>
      <p className="dialog-detail">At least one of these:</p>
      <div className="requirement-list">
        {requirements.agents.map((agent) => (
          <RequirementRow key={agent.name} requirement={agent} />
        ))}
      </div>
      <p className="dialog-detail">
        …or SBX alone, which runs the agents in a container, so none of them has to be installed
        here:
      </p>
      <div className="requirement-list">
        <RequirementRow requirement={requirements.sbx} />
      </div>
      <p className="dialog-detail">
        A program installed somewhere outside its package manager's usual place may only be
        found once tet is restarted.
      </p>
    </DialogFrame>
  );
}
