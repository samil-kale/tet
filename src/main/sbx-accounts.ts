import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { errorMessage } from "../shared/errors";
import type { SbxAccount, SbxAccountEdit, SbxSignInResult } from "../shared/types";
import { isRecord, readJson, saveJson } from "./json-file";
import { readSbxUser, runSbxTokenLogin } from "./sbx";
import { seal, unseal } from "./sealed";

/** What the file holds: the account plus its token, encrypted by the OS and base64-wrapped. */
interface StoredSbxAccount extends SbxAccount {
  token: string;
}

function toAccount(entry: StoredSbxAccount): SbxAccount {
  return { id: entry.id, user: entry.user };
}

/**
 * The Docker access tokens of the SBX Settings' General tab, one list for every project — sbx has
 * one sign-in per machine. A token leaves this class only decrypted into `sbx login`'s stdin
 * (sbx.ts's runSbxTokenLogin); the renderer never sees one.
 */
export class SbxAccountStore {
  private readonly file: string;
  private accounts: StoredSbxAccount[] = [];

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, "sbx-accounts.json");
    this.load();
  }

  list(): SbxAccount[] {
    return this.accounts.map(toAccount);
  }

  /** The decrypted token; undefined when there is none, or it cannot be decrypted. */
  token(accountId: string): string | undefined {
    const entry = this.accounts.find((account) => account.id === accountId);
    return entry && unseal(entry.token);
  }

  /** Adds the account, or replaces the token of the same user — never two rows. `replacing`, the
   *  account the token was signed in from, is this one now, under the name sbx gave (signInToSbx).
   *  Throws before changing anything when the OS offers no encryption (`seal`). */
  add(user: string, token: string, replacing?: string): SbxAccount {
    const encrypted = seal(token);
    const existing =
      this.accounts.find((account) => account.user === user) ?? this.accounts.find((account) => account.id === replacing);
    this.accounts = this.accounts.filter((account) => account === existing || account.id !== replacing);
    if (existing) {
      existing.user = user;
      existing.token = encrypted;
      this.save();
      return toAccount(existing);
    }
    const stored: StoredSbxAccount = { id: randomUUID(), user, token: encrypted };
    this.accounts.push(stored);
    this.save();
    return toAccount(stored);
  }

  /**
   * Save's rows: a typed token, else the stored one of the account the row was opened as; a row
   * with neither, or without a user, is dropped, and a later row wins over an earlier one of the
   * same user. Throws before changing anything when the OS offers no encryption (`seal`).
   */
  update(edits: SbxAccountEdit[]): void {
    const next = new Map<string, StoredSbxAccount>();
    for (const edit of edits) {
      const user = edit.user.trim();
      const opened = edit.id === undefined ? undefined : this.accounts.find((account) => account.id === edit.id);
      const token = edit.token !== "" ? seal(edit.token) : opened?.token;
      if (user !== "" && token !== undefined) {
        next.set(user, { id: opened?.id ?? randomUUID(), user, token });
      }
    }
    const accounts = [...next.values()];
    // Written only on a change: every SBX Save passes through here.
    if (JSON.stringify(accounts) !== JSON.stringify(this.accounts)) {
      this.accounts = accounts;
      this.save();
    }
  }

  private load(): void {
    const parsed = readJson(this.file);
    if (Array.isArray(parsed)) {
      this.accounts = parsed.filter(
        (entry): entry is StoredSbxAccount =>
          isRecord(entry) && typeof entry.id === "string" && typeof entry.user === "string" && typeof entry.token === "string"
      );
    }
  }

  private save(): void {
    // Renamed into place: `load` reads a half-written file as no accounts, and the next save would keep that.
    saveJson(this.file, this.accounts, "sbx-accounts.json");
  }
}

/**
 * `sbx login` with `typed`, or the token kept for `accountId` when nothing was typed; the account is
 * kept (or its token replaced) once sbx took it, under the name sbx then gives — an email or another
 * case typed is the same account, and its row is marked signed in by that name. The dialog's
 * sign-in (`cancellable`, sbx.ts's readSbxUser) and `tet-ctl sbx-sign-in`.
 */
export async function signInToSbx(
  store: SbxAccountStore,
  typedUser: string,
  typed: string,
  accountId: string | undefined,
  cancellable: boolean
): Promise<SbxSignInResult> {
  const user = typedUser.trim();
  const token = typed !== "" ? typed : accountId !== undefined ? store.token(accountId) : undefined;
  if (token === undefined) {
    return { signedIn: false, error: "No access token stored for this account on this machine; enter it again" };
  }
  const refused = await runSbxTokenLogin(user, token, cancellable);
  if (refused !== undefined) {
    return { signedIn: false, error: refused };
  }
  const named = (await readSbxUser(cancellable)) ?? user;
  try {
    return { signedIn: true, account: store.add(named, token, accountId) };
  } catch (error) {
    return { signedIn: true, error: errorMessage(error) };
  }
}
