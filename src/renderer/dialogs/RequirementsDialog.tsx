import type { Requirement, Requirements } from "../../shared/types";
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

/**
 * What is missing, and where it comes from. Not part of Dialog.tsx: that file puts a question
 * and resolves to an answer, and this is a wall — it stands until the programs it lists are
 * there, there is nothing behind it yet, and no Escape takes it away.
 *
 * It installs nothing itself. No command would work on every platform: a package manager that
 * may not be there, an elevation prompt, a shell to answer in — and a button that works on one
 * of the three would be worse than none.
 */
export function RequirementsDialog({ requirements, checking, onRecheck }: RequirementsDialogProps) {
  return (
    <div className="dialog-overlay">
      <div className="dialog">
        <div className="dialog-title">TET cannot start</div>
        <div className="dialog-body">
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
        </div>
        <div className="dialog-buttons">
          <button type="button" className="button secondary" onClick={() => window.tet.startup.quit()}>
            Quit
          </button>
          <button type="button" className="button" onClick={onRecheck} disabled={checking}>
            {checking && <SpinnerIcon className="spinning" />}
            <span>Check again</span>
          </button>
        </div>
      </div>
    </div>
  );
}
