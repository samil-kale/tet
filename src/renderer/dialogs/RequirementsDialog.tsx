import type { Requirement, Requirements } from "../../shared/types/agents";
import { DialogFrame } from "../ui/DialogFrame";

/** The command to try in a terminal on the left, what the check found on the right. */
function RequirementRow({ requirement }: { requirement: Requirement }) {
  return (
    <div className="requirement-row">
      <span className="requirement-command">{requirement.command}</span>
      <span className={requirement.installed ? "requirement-state found" : "requirement-state"}>
        {requirement.installed ? "Installed" : "Missing"}
      </span>
    </div>
  );
}

interface RequirementsDialogProps {
  /** What the check found; none where it failed before saying (`failure`). */
  requirements?: Requirements;
  /** Why the check failed: the stored projects did not open. */
  failure?: string;
  /** A check is running: the header's bar meanwhile. */
  busy: boolean;
  onRecheck: () => void;
}

/** What is missing, or why the check failed. Not in Dialog.tsx: a wall, not a question — it stands
 *  until the programs are there, with no Escape. Installs nothing: no command works on all three
 *  platforms. */
export function RequirementsDialog({ requirements, failure, busy, onRecheck }: RequirementsDialogProps) {
  return (
    <DialogFrame
      // No cancel: nothing stands behind this yet.
      header={{ title: requirements ? "Missing requirements" : "TET could not start" }}
      busy={busy}
      error={failure}
      // The check only reads, so Quit stays open while it runs.
      locked={false}
      actions={[{ label: "Quit", secondary: true, run: () => window.tet.startup.quit() }]}
      primary={{ label: "Check again", disabled: busy, run: onRecheck }}
    >
      {requirements ? (
        <>
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
        </>
      ) : (
        <p className="dialog-message">The projects could not be opened. Check again to retry.</p>
      )}
    </DialogFrame>
  );
}
