import { useEffect, useRef, useState } from "react";
import type { EnvRequest } from "../../shared/types";
import { DialogFrame, useSubmit } from "../ui/DialogFrame";
import { EditRow, OverridesMachine, RowSection, SecretInput } from "../ui/RowSection";
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
 * refuses Save stays in the dialog. A tab takes up saved values only when it starts, so saving restarts
 * the asking one; a request without a tab only saves.
 */
export function EnvDialog({ request, requester, onClose }: EnvDialogProps) {
  // Keyed by name: the agent's names are unique (the verb dedupes them).
  const [rows, setRows] = useState(() =>
    request.variables.map((variable) => ({ ...variable, id: variable.name, value: "" }))
  );
  const firstValue = useRef<HTMLInputElement>(null);

  useEffect(() => firstValue.current?.focus(), []);

  const cancel = (): void => {
    void window.tet.environment.answer(request.id, null);
    onClose();
  };
  useEscape(cancel);

  const complete = rows.every((row) => row.value !== "");
  const tab = request.projectId && request.tabId ? { projectId: request.projectId, tabId: request.tabId } : undefined;

  // The asking tab restarts once saved, so it takes up the values (pty.ts).
  const { busy, refused, submit: save, clear } = useSubmit(
    () => window.tet.environment.answer(request.id, rows.map((row) => ({ name: row.name, value: row.value }))),
    () => {
      if (tab) {
        void window.tet.terminals.restart(tab.projectId, tab.tabId);
      }
      onClose();
    }
  );

  const edit = (name: string, value: string): void => {
    setRows((current) => current.map((row) => (row.name === name ? { ...row, value } : row)));
    clear();
  };

  return (
    <DialogFrame
      className="env-dialog"
      header={{
        title: rows.length === 1 ? "Environment variable needed" : "Environment variables needed",
        onClose: cancel
      }}
      busy={busy}
      error={refused}
      onSubmit={() => {
        if (complete) {
          void save();
        }
      }}
      buttons={
        <>
          <button type="button" className="button secondary" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={!complete || busy}>
            {tab ? "Save & Restart" : "Save"}
          </button>
        </>
      }
    >
      <p className="dialog-message">{requester} asks for environment variables.</p>
      <RowSection
        label="Environment variables"
        rows={rows}
        renderRow={(row) => (
          // The Settings' Environment rows, the name fixed: it is the agent's.
          <EditRow key={row.id}>
            <input className="row-fill-input" type="text" value={row.name} disabled />
            {row.overridesMachine && <OverridesMachine name={row.name} />}
            <SecretInput
              ref={row === rows[0] ? firstValue : undefined}
              stored={row.stored}
              value={row.value}
              onChange={(value) => edit(row.name, value)}
            />
          </EditRow>
        )}
      />
      <p className="dialog-detail">
        Stored on this machine and set in every tab TET starts, a sandboxed one excepted.
      </p>
    </DialogFrame>
  );
}
