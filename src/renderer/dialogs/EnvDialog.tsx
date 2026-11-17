import { useState } from "react";
import type { EnvRequest } from "../../shared/types/environment";
import { refusal } from "../ui/Dialog";
import { DialogFrame, useSubmit } from "../ui/DialogFrame";
import { EditRow, OverridesMachine, RowInput, RowSection, SecretInput } from "../ui/RowSection";

interface EnvDialogProps {
  request: EnvRequest;
  /** Answered, withdrawn or put off: App takes the dialog down. */
  onClose: () => void;
}

/**
 * What an agent asked for with `tet-ctl env-request`: environment variables typed here and never
 * into the chat. The one question the main process asks (AGENTS.md): it runs its own answer, so what
 * refuses Save stays in the dialog. A tab takes up saved values only when it starts: the asking
 * agent tells the user to restart it (`restartRequired`), never the dialog.
 */
export function EnvDialog({ request, onClose }: EnvDialogProps) {
  // Keyed by name: the agent's names are unique (the verb dedupes them).
  const [rows, setRows] = useState(() => request.variables.map((variable) => ({ ...variable, id: variable.name, value: "" })));

  const complete = rows.every((row) => row.value !== "");

  const {
    busy,
    refused,
    submit: save,
    changing,
  } = useSubmit(
    async () =>
      refusal(
        await window.tet.env.answer(
          request.id,
          rows.map((row) => ({ name: row.name, value: row.value })),
        ),
      ),
    onClose,
  );

  const cancel = (): void => {
    void window.tet.env.answer(request.id, null);
    onClose();
  };

  const edit = changing((name: string, value: string): void =>
    setRows((current) => current.map((row) => (row.name === name ? { ...row, value } : row))),
  );

  return (
    <DialogFrame
      header={{ title: "Environment variables needed" }}
      busy={busy}
      error={refused}
      onCancel={cancel}
      // Plain to see why it waits: a value left empty.
      primary={{ label: "Save", disabled: !complete, run: () => void save() }}
    >
      <RowSection
        label="Environment variables"
        rows={rows}
        renderRow={(row) => (
          // The Settings' Environment rows, the name fixed: it is the agent's.
          <EditRow key={row.id}>
            <RowInput value={row.name} readOnly />
            {row.overridesMachine && <OverridesMachine name={row.name} />}
            <SecretInput stored={row.stored} value={row.value} onChange={(value) => edit(row.name, value)} />
          </EditRow>
        )}
      />
      <p className="dialog-detail">
        Stored in <span className="dialog-emphasis">~/.tet/environment.json</span> and set in every tab TET starts, except in a sandboxed
        one.
      </p>
    </DialogFrame>
  );
}
