import type { Dispatch, SetStateAction } from "react";
import type { SbxAccount, SbxAccountEdit } from "../../shared/types";
import { ActionLink } from "../ui/ActionLink";
import { atLeastOne, EditRow, patched, RowSection, SecretInput, withId, without, type Row } from "../ui/RowSection";
import { CheckIcon, LogInIcon } from "../ui/icons";

/** An access token row: `account` the stored one it was opened as, `token` only what was typed
 *  since — a stored token never reaches the renderer; `mark` what sbx said on refusing it. */
export type AccountRow = Row<{ account?: string; user: string; token: string; mark?: string }>;

/** A row as "+ Add" makes it, and as one stands in where there are none (`atLeastOne`). */
const BLANK_ACCOUNT = { user: "", token: "" };

/** `sbx:accounts`' answer as rows. */
export function fromAccounts(accounts: SbxAccount[]): AccountRow[] {
  return atLeastOne(
    accounts.map((account) => withId({ account: account.id, user: account.user, token: "" })),
    BLANK_ACCOUNT
  );
}

/** The rows as Save keeps them (SbxAccountStore.update). */
export function toAccountEdits(rows: AccountRow[]): SbxAccountEdit[] {
  return rows.map((row) => ({ id: row.account, user: row.user, token: row.token }));
}

interface SbxAccountsProps {
  rows: AccountRow[];
  setRows: Dispatch<SetStateAction<AccountRow[]>>;
  /** Signed in to Docker; `signedInUser` whom sbx names, however signed in. */
  signedIn: boolean;
  signedInUser?: string;
  /** A sign-in, sign-out or check runs: nothing else may start. */
  busy: boolean;
  onSignIn: (row: AccountRow) => void;
  onBrowserSignIn: () => void;
  onSignOut: () => void;
}

/**
 * The General tab's Docker account: who is signed in, and the access tokens kept for every project
 * — sbx has one sign-in per machine. A row's sign-in runs at once and keeps that row; adding or
 * removing one is an edit like any other, written on Save.
 */
export function SbxAccounts({
  rows,
  setRows,
  signedIn,
  signedInUser,
  busy,
  onSignIn,
  onBrowserSignIn,
  onSignOut
}: SbxAccountsProps) {
  const setRow = (row: AccountRow, change: Partial<AccountRow>): void =>
    setRows((current) => patched(current, row.id, { ...change, mark: undefined }));
  return (
    <div className="sbx-account">
      <div className="sbx-account-status">
        <span>
          {!signedIn ? (
            "Not signed in to Docker"
          ) : signedInUser !== undefined ? (
            <>
              Signed in to Docker as <strong>{signedInUser}</strong>
            </>
          ) : (
            "Signed in to Docker"
          )}
        </span>
        {signedIn ? (
          <button type="button" className="button secondary" disabled={busy} onClick={onSignOut}>
            Sign out
          </button>
        ) : (
          <button type="button" className="button secondary" disabled={busy} onClick={onBrowserSignIn}>
            Sign in with browser
          </button>
        )}
      </div>
      <RowSection
        label="Access tokens"
        rows={rows}
        renderRow={(row) => {
          const user = row.user.trim();
          const current = row.account !== undefined && user === signedInUser;
          return (
            <EditRow
              key={row.id}
              mark={row.mark}
              remove="Remove access token"
              onRemove={() => setRows((list) => atLeastOne(without(list, row.id), BLANK_ACCOUNT))}
            >
              <input
                className="row-fill-input"
                type="text"
                placeholder="Docker username"
                // A kept token belongs to its user: another user is another row.
                disabled={row.account !== undefined}
                title={row.account !== undefined ? "The Docker account this token belongs to" : undefined}
                value={row.user}
                onChange={(event) => setRow(row, { user: event.target.value })}
              />
              <SecretInput
                stored={row.account !== undefined}
                storedTitle="Stored on this machine; typing replaces it."
                emptyTitle="A Docker personal access token, stored on this machine."
                placeholder="Token"
                value={row.token}
                onChange={(token) => setRow(row, { token })}
              />
              {current ? (
                <span className="sbx-account-current" title="Signed in">
                  <CheckIcon />
                </span>
              ) : (
                <button
                  type="button"
                  className="icon-button"
                  title={user ? `Sign in as ${user}` : "Sign in"}
                  disabled={busy || user === "" || (row.token === "" && row.account === undefined)}
                  onClick={() => onSignIn(row)}
                >
                  <LogInIcon />
                </button>
              )}
            </EditRow>
          );
        }}
        add={
          <ActionLink onClick={() => setRows((current) => [...current, withId(BLANK_ACCOUNT)])}>
            + Add access token
          </ActionLink>
        }
      />
    </div>
  );
}
