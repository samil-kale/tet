import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ProviderAccount, ProviderId } from "../../shared/types";
import { readRows, writeJson } from "../json-file";
import { seal, unseal } from "../sealed";
import { PROVIDERS } from "./index";

/** What the file holds: the account plus its token, encrypted by the OS and base64-wrapped. */
interface StoredAccount extends ProviderAccount {
  token: string;
}

/** The account as the renderer may see it — every field but the token. */
function toAccount(entry: StoredAccount): ProviderAccount {
  return {
    id: entry.id,
    provider: entry.provider,
    host: entry.host,
    user: entry.user,
    namespace: entry.namespace
  };
}

/** The configured accounts. A token leaves this class only decrypted into a provider call or a
 *  clone; the renderer never sees one. */
export class AccountStore {
  private readonly file: string;
  private accounts: StoredAccount[] = [];

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, "provider-accounts.json");
    this.load();
  }

  list(): ProviderAccount[] {
    return this.accounts.map(toAccount);
  }

  get(accountId: string): ProviderAccount | undefined {
    const entry = this.find(accountId);
    return entry && toAccount(entry);
  }

  /** Adds the account, or replaces the token of the same user on the same host — never two rows. */
  add(provider: ProviderId, host: string, user: string, token: string): ProviderAccount {
    const encrypted = seal(token);
    const existing = this.accounts.find(
      (account) => account.provider === provider && account.host === host && account.user === user
    );
    const stored: StoredAccount = existing ? { ...existing, token: encrypted } : { id: randomUUID(), provider, host, user, token: encrypted };
    this.save(existing ? this.accounts.map((account) => (account === existing ? stored : account)) : [...this.accounts, stored]);
    return toAccount(stored);
  }

  /** Remembers the group the remote tab was narrowed to, so it opens there the next time. */
  setNamespace(accountId: string, namespace: string): void {
    const entry = this.find(accountId);
    if (entry) {
      this.save(this.accounts.map((account) => (account === entry ? { ...entry, namespace } : account)));
    }
  }

  remove(accountId: string): void {
    this.save(this.accounts.filter((account) => account.id !== accountId));
  }

  /** The decrypted token; undefined when it cannot be decrypted. */
  token(accountId: string): string | undefined {
    const entry = this.find(accountId);
    return entry && unseal(entry.token);
  }

  private find(accountId: string): StoredAccount | undefined {
    return this.accounts.find((account) => account.id === accountId);
  }

  private load(): void {
    this.accounts = readRows<StoredAccount>(
      this.file,
      ["id", "provider", "host", "user", "token"],
      (entry) =>
        Object.hasOwn(PROVIDERS, entry.provider as string) &&
        (entry.namespace === undefined || typeof entry.namespace === "string")
    );
  }

  /** Throws when the file cannot be written, the accounts unchanged. */
  private save(accounts: StoredAccount[]): void {
    // Renamed into place: `load` reads a half-written file as no accounts, and the next save would keep that.
    writeJson(this.file, accounts);
    this.accounts = accounts;
  }
}
