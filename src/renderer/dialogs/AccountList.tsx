import { useState, type ReactNode } from "react";
import type { ProviderAccount } from "../../shared/types/providers";
import { accountsChanged, PROVIDER_LABEL } from "../git/ProviderAccount";
import { confirmed, refusal } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { CloseIcon } from "../ui/icons";
import { RowMark } from "../ui/RowSection";

interface AccountListProps {
  accounts: ProviderAccount[];
  /** The row shown selected. */
  selectedId?: string | null;
  /** Picks a row; left out where rows are not picked (the Settings' Accounts tab). */
  onSelect?: (accountId: string) => void;
  /** Runs a removal as a held run of the dialog's frame: it deletes the stored token, so the dialog
   *  stays up until the answer lands beside the row. */
  runHeld: <T>(work: () => Promise<T>) => Promise<T>;
  /** A held run: its rows cannot be picked, as picking one unmounts the form. */
  locked: boolean;
  /** The account's removal went through. */
  onRemoved: (account: ProviderAccount) => void;
  /** Underneath the rows. */
  children?: ReactNode;
}

/** The accounts added for the git hosts, a row each with its removal. */
export function AccountList({ accounts, selectedId, onSelect, runHeld, locked, onRemoved, children }: AccountListProps) {
  /** Why an account could not be removed, beside its row until the next try. */
  const [removeError, setRemoveError] = useState<{ accountId: string; message: string } | undefined>(undefined);

  const removeAccount = async (account: ProviderAccount): Promise<void> => {
    const answer = await confirmed({
      title: "Remove account",
      message: `Remove ${account.user} on ${account.host}?`,
      detail: "The stored token is deleted with it.",
      confirmLabel: "Remove",
    });
    if (!answer) {
      return;
    }
    const failed = refusal(await runHeld(() => window.tet.providers.removeAccount(account.id)));
    setRemoveError(failed === undefined ? undefined : { accountId: account.id, message: failed });
    if (failed === undefined) {
      accountsChanged();
      onRemoved(account);
    }
  };

  return (
    <div className="master-list">
      {accounts.map((account) => (
        <div
          key={account.id}
          className={`list-row master-row two-line${account.id === selectedId ? " active" : ""}${locked ? " disabled" : ""}${onSelect ? "" : " static"}`}
          onClick={onSelect && !locked ? () => onSelect(account.id) : undefined}
        >
          <span className="list-main">
            <span className="list-label">{account.user}</span>
            <span className="list-detail">
              {PROVIDER_LABEL[account.provider]} · {account.host}
            </span>
          </span>
          <RowMark title={removeError?.accountId === account.id ? removeError.message : undefined} />
          <IconButton title="Remove account" isolated onClick={() => void removeAccount(account)}>
            <CloseIcon />
          </IconButton>
        </div>
      ))}
      {children}
    </div>
  );
}
