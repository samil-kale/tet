import { useEffect, useRef, useState } from "react";
import { overridesMachineNote } from "../../shared/types";
import type { EnvRequest } from "../../shared/types";
import { DialogFrame } from "../ui/DialogFrame";
import { TextField } from "../ui/Field";
import { useEscape } from "../ui/use-escape";

interface EnvDialogProps {
  request: EnvRequest;
  /** Who asks, as the window names that tab: "Claude in autocontract". */
  requester: string;
  /** Answered, withdrawn or put off: App takes the dialog down. */
  onClose: () => void;
}

/**
 * What an agent asked for with `tet-ctl env-request`: environment variables typed here and never
 * into the chat. The one question the main process asks (AGENTS.md): it runs its own answer, so what
 * refuses Save stays in the dialog. A tab takes up saved values only when it starts, so once saved
 * the dialog offers to restart the asking one — never on its own.
 */
export function EnvDialog({ request, requester, onClose }: EnvDialogProps) {
  const [rows, setRows] = useState(() =>
    request.variables.map((variable) => ({ name: variable.name, value: "" }))
  );
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const firstValue = useRef<HTMLInputElement>(null);

  useEffect(() => firstValue.current?.focus(), []);

  const edit = (name: string, value: string): void => {
    setRows((current) => current.map((row) => (row.name === name ? { ...row, value } : row)));
    setRefused(undefined);
  };

  const cancel = (): void => {
    if (!saved) {
      void window.tet.environment.answer(request.id, null);
    }
    onClose();
  };
  useEscape(cancel);

  const complete = rows.every((row) => row.value !== "");
  const overriding = request.variables.filter((variable) => variable.overridesMachine).map((variable) => variable.name);
  const tab = request.projectId && request.tabId ? { projectId: request.projectId, tabId: request.tabId } : undefined;

  const save = async (): Promise<void> => {
    if (!complete || busy) {
      return;
    }
    setBusy(true);
    const error = await window.tet.environment.answer(request.id, rows);
    setBusy(false);
    if (error === undefined) {
      setSaved(true);
    } else {
      setRefused(error);
    }
  };

  const restart = (): void => {
    if (tab) {
      void window.tet.terminals.restart(tab.projectId, tab.tabId);
    }
    onClose();
  };

  if (saved) {
    return (
      <DialogFrame
        header={{ title: "Environment variables saved", onClose }}
        onSubmit={tab ? restart : onClose}
        buttons={
          tab ? (
            <>
              <button type="button" className="button secondary" onClick={onClose}>
                Later
              </button>
              <button type="submit" className="button">
                Restart session
              </button>
            </>
          ) : (
            <button type="submit" className="button">
              Close
            </button>
          )
        }
      >
        <p className="dialog-message">
          {tab
            ? `${requester} sees them once its session restarts; every tab started from now on has them.`
            : "Every tab started from now on has them."}
        </p>
        {overriding.length > 0 && <p className="dialog-detail">{overridesMachineNote(overriding)}</p>}
      </DialogFrame>
    );
  }

  return (
    <DialogFrame
      header={{ title: `Environment variables for ${requester}`, onClose: cancel }}
      busy={busy}
      error={refused}
      onSubmit={() => void save()}
      buttons={
        <>
          <button type="button" className="button secondary" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={!complete || busy}>
            Save
          </button>
        </>
      }
    >
      <p className="dialog-message">{requester} asks for environment variables.</p>
      {request.reason && <p className="dialog-detail">“{request.reason}”</p>}
      {rows.map((row, index) => {
        const stored = request.variables.find((variable) => variable.name === row.name)?.stored;
        return (
          <TextField
            key={row.name}
            label={stored ? `${row.name} (replaces the stored value)` : row.name}
            type="password"
            value={row.value}
            onChange={(value) => edit(row.name, value)}
            ref={index === 0 ? firstValue : undefined}
          />
        );
      })}
      <p className="dialog-detail">
        Stored encrypted on this machine and set in every tab TET starts, a sandboxed one excepted.
      </p>
    </DialogFrame>
  );
}
