import { useState } from "react";
import type { EnvRequest } from "../../shared/types/environment";
import { DialogFrame, useSubmit } from "../ui/DialogFrame";
import { EditRow, OverridesMachine, RowInput, RowSection, SecretInput } from "../ui/RowSection";

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

  const complete = rows.every((row) => row.value !== "");
  const tab = request.ref && request.tabId ? { ref: request.ref, tabId: request.tabId } : undefined;

  // The asking tab restarts once saved, so it takes up the values (pty.ts).
  const { busy, refused, submit: save, changing } = useSubmit(
    () => window.tet.environment.answer(request.id, rows.map((row) => ({ name: row.name, value: row.value }))),
    () => {
      if (tab) {
        void window.tet.terminals.restart(tab.ref, tab.tabId);
      }
      onClose();
    }
  );

  const cancel = (): void => {
    void window.tet.environment.answer(request.id, null);
    onClose();
  };

  const edit = changing((name: string, value: string): void =>
    setRows((current) => current.map((row) => (row.name === name ? { ...row, value } : row)))
  );

  return (
    <DialogFrame
      className="env-dialog"
      header={{ title: rows.length === 1 ? "Environment variable needed" : "Environment variables needed" }}
      busy={busy}
      error={refused}
      onCancel={cancel}
      // Plain to see why it waits: a value left empty.
      primary={{ label: tab ? "Save & Restart" : "Save", disabled: !complete, run: () => void save() }}
    >
      <p className="dialog-message">{requester} asks for environment variables.</p>
      <RowSection
        label="Environment variables"
        rows={rows}
        renderRow={(row) => (
          // The Settings' Environment rows, the name fixed: it is the agent's.
          <EditRow key={row.id}>
            <RowInput value={row.name} readOnly />
            {row.overridesMachine && <OverridesMachine name={row.name} />}
            <SecretInput
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
