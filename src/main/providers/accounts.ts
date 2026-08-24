import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { safeStorage } from "electron";
import type { ProviderAccount, ProviderId } from "../../shared/types";

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

/**
 * The configured accounts, persisted like the projects — except for the token, which only
 * leaves this class decrypted on its way into a provider call or a clone. The renderer sees
 * accounts without tokens, full stop.
 */
export class AccountStore {
  private readonly file: string;
  private accounts: StoredAccount[] = [];

  constructor(userDataPath: string) {
    this.file = path.join(userDataPath, "provider-accounts.json");
    this.load();
  }

  list(): ProviderAccount[] {
    return this.accounts.map(toAccount);
  }

  get(accountId: string): ProviderAccount | undefined {
    const entry = this.accounts.find((account) => account.id === accountId);
    return entry && toAccount(entry);
  }

  /**
   * Adds the account, or — for the same user on the same host — replaces its token: entering
   * a fresh token for an account that expired must not leave two rows behind.
   */
  add(provider: ProviderId, host: string, user: string, token: string): ProviderAccount {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("The OS offers no encryption to store the token with");
    }
    const encrypted = safeStorage.encryptString(token).toString("base64");
    const existing = this.accounts.find(
      (account) => account.provider === provider && account.host === host && account.user === user
    );
    if (existing) {
      existing.token = encrypted;
      this.save();
      return toAccount(existing);
    }
    const stored: StoredAccount = { id: randomUUID(), provider, host, user, token: encrypted };
    this.accounts.push(stored);
    this.save();
    return toAccount(stored);
  }

  /** Remembers the group the remote tab was narrowed to, so it opens there the next time. */
  setNamespace(accountId: string, namespace: string): void {
    const entry = this.accounts.find((account) => account.id === accountId);
    if (entry) {
      entry.namespace = namespace;
      this.save();
    }
  }

  remove(accountId: string): void {
    this.accounts = this.accounts.filter((account) => account.id !== accountId);
    this.save();
  }

  /** The decrypted token, for a provider call or a clone; undefined when it cannot be had. */
  token(accountId: string): string | undefined {
    const entry = this.accounts.find((account) => account.id === accountId);
    if (!entry) {
      return undefined;
    }
    try {
      return safeStorage.decryptString(Buffer.from(entry.token, "base64"));
    } catch {
      // Encrypted under an OS keychain this machine no longer has — the account needs its
      // token entered again, which replacing it through `add` is for.
      return undefined;
    }
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(parsed)) {
        this.accounts = parsed.filter(
          (entry): entry is StoredAccount =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as StoredAccount).id === "string" &&
            ((entry as StoredAccount).provider === "github" || (entry as StoredAccount).provider === "gitlab") &&
            typeof (entry as StoredAccount).host === "string" &&
            typeof (entry as StoredAccount).user === "string" &&
            typeof (entry as StoredAccount).token === "string" &&
            ((entry as StoredAccount).namespace === undefined ||
              typeof (entry as StoredAccount).namespace === "string")
        );
      }
    } catch {
      // No file yet, or unreadable — no accounts.
      this.accounts = [];
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.accounts, null, 2), "utf8");
    } catch (error) {
      console.error("[tet] could not persist accounts:", error);
    }
  }
}
