import { useEffect, useState } from "react";
import type { ProviderAccount } from "../../shared/types/providers";
import { AccountFields, accountReady, addAccount, emptyAccount } from "../git/ProviderAccount";
import { ActionLink } from "../ui/ActionLink";
import { useSubmit } from "../ui/DialogFrame";
import { FieldColumn } from "../ui/Field";
import { useBusy } from "../ui/use-busy";
import { AccountList } from "./AccountList";

interface ProviderAccountsProps {
  /** An account is being added or removed: the dialog holds its tabs and Cancel until it is done. */
  onBusy: (busy: boolean) => void;
}

/**
 * The Settings' Accounts tab, laid out as the add-repository dialog's account form: the accounts
 * added for the git hosts, and the form for another. Adding and removing act at once, since the
 * host checks a token on the spot and a removal deletes it.
 */
export function ProviderAccounts({ onBusy }: ProviderAccountsProps) {
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [draft, setDraft] = useState(() => emptyAccount());
  const { busy: removing, run: runRemoval } = useBusy();
  const {
    busy: adding,
    refused,
    submit,
    changing,
  } = useSubmit(async () => {
    const result = await addAccount(draft);
    if (!result.ok) {
      return result.error;
    }
    // Replace, not append: a fresh token answers with the same account id.
    setAccounts((current) => [...current.filter((entry) => entry.id !== result.account.id), result.account]);
    setDraft(emptyAccount());
    return undefined;
  });
  const busy = adding || removing;

  useEffect(() => {
    void window.tet.providers.accounts().then(setAccounts);
  }, []);

  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);

  return (
    <div className="accounts-tab">
      <AccountList
        accounts={accounts}
        runHeld={runRemoval}
        locked={busy}
        onRemoved={(account) => setAccounts((current) => current.filter((entry) => entry.id !== account.id))}
      />
      <FieldColumn fill>
        <AccountFields value={draft} onChange={changing(setDraft)} error={refused} />
        <ActionLink disabled={!accountReady(draft) || busy} onClick={() => void submit()}>
          + Add account
        </ActionLink>
      </FieldColumn>
    </div>
  );
}
