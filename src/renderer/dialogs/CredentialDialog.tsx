import { useEffect, useRef, useState } from "react";
import type { CredentialRequest } from "../../shared/types";
import { DialogFrame } from "../ui/DialogFrame";
import { TextField } from "../ui/Field";
import { useEscape } from "../ui/use-escape";

interface CredentialDialogProps {
  request: CredentialRequest;
  /** Who asks, as the window names that tab: "Claude in autocontract". */
  requester: string;
  /** Answered or withdrawn: App takes the dialog down. */
  onClose: () => void;
}

/**
 * What an agent asked for with `tet-ctl credentials-request`, typed here and never into the chat.
 * The one question the main process asks (AGENTS.md): it runs its own answer, so what refuses Save
 * stays in the dialog. A name already stored asks to replace its value, the same fields with name
 * and host fixed — another host is another credential.
 */
export function CredentialDialog({ request, requester, onClose }: CredentialDialogProps) {
  const [name, setName] = useState(request.name);
  const [host, setHost] = useState(request.host ?? "");
  const [account, setAccount] = useState(request.account ?? "");
  const [description, setDescription] = useState(request.description ?? "");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const valueField = useRef<HTMLInputElement>(null);

  useEffect(() => valueField.current?.focus(), []);

  const cancel = (): void => {
    void window.tet.credentials.answer(request.id, null);
    onClose();
  };
  useEscape(cancel);

  const save = async (): Promise<void> => {
    if (name.trim() === "" || value === "" || busy) {
      return;
    }
    setBusy(true);
    const error = await window.tet.credentials.answer(request.id, { name, host, account, description, value });
    setBusy(false);
    if (error === undefined) {
      onClose();
    } else {
      setRefused(error);
    }
  };

  return (
    <DialogFrame
      header={{ title: request.replace ? "Replace credential" : `Credential for ${requester}`, onClose: cancel }}
      busy={busy}
      error={refused}
      onSubmit={() => void save()}
      buttons={
        <>
          <button type="button" className="button secondary" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={name.trim() === "" || value === "" || busy}>
            {request.replace ? "Replace" : "Save"}
          </button>
        </>
      }
    >
      <p className="dialog-message">
        {request.replace
          ? `${requester} says the stored ${request.name} no longer works.`
          : `${requester} asks for a credential.`}
      </p>
      {request.reason && <p className="dialog-detail">“{request.reason}”</p>}
      <TextField label="Name" value={name} onChange={setName} disabled={request.replace} />
      <TextField label="Host (optional)" value={host} onChange={setHost} disabled={request.replace} />
      <TextField label="Account (optional)" value={account} onChange={setAccount} />
      <TextField
        label="Description (optional)"
        placeholder="What it is and what it grants"
        value={description}
        onChange={setDescription}
      />
      <TextField
        label={request.replace ? "New token or password" : "Token or password"}
        type="password"
        value={value}
        onChange={(next) => {
          setValue(next);
          setRefused(undefined);
        }}
        ref={valueField}
      />
      <p className="dialog-detail">
        {request.replace
          ? "Replace overwrites the stored value; there is no way back to the old one."
          : "Stored encrypted on this machine. Agents outside a sandbox read it with tet-ctl credentials-get."}
      </p>
    </DialogFrame>
  );
}
