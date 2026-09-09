import type { Requirement, Requirements } from "../../shared/types";
import { DialogFrame } from "../ui/DialogFrame";
import { SpinnerIcon } from "../ui/icons";

/** Name on the left, what the check found on the right, and where to get it when it is missing. */
function RequirementRow({ requirement }: { requirement: Requirement }) {
  return (
    <div className="requirement-item">
      <span className="requirement-name">{requirement.name}</span>
      <span className="requirement-command">{requirement.command}</span>
      {requirement.installed ? (
        <span className="requirement-state found">Installed</span>
      ) : (
        <>
          <span className="requirement-state">Missing</span>
          <button
            type="button"
            className="requirement-link"
            onClick={() => void window.tet.shell.openUrl(requirement.url)}
          >
            Get it
          </button>
        </>
      )}
    </div>
  );
}

interface RequirementsDialogProps {
  requirements: Requirements;
  /** Whether a check is running right now; the button turns while its own action does. */
  checking: boolean;
  onRecheck: () => void;
}

/** What is missing, and where it comes from. Not part of Dialog.tsx: this is a wall, not a
 *  question — it stands until the programs it lists are there, and no Escape takes it away.
 *  Installs nothing: no command works on all three platforms. */
export function RequirementsDialog({ requirements, checking, onRecheck }: RequirementsDialogProps) {
  return (
    <DialogFrame
      // No close button: nothing stands behind this yet.
      header={{ title: "TET cannot start" }}
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
        Git runs the whole git side, and an agent is what the terminals are for. Install what is
        missing, then check again.
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
        A program installed somewhere outside its package manager's usual place may only be
        found once tet is restarted.
      </p>
    </DialogFrame>
  );
}
