import * as fs from "node:fs";
import * as path from "node:path";
import { safeStorage } from "electron";
import writeFileAtomic from "write-file-atomic";
import { errorMessage } from "../shared/errors";
import type { CredentialAnswer, CredentialInfo, CredentialRequest } from "../shared/types";

/** What the file holds: the credential plus its value, encrypted by the OS and base64-wrapped. */
interface StoredCredential extends CredentialInfo {
  value: string;
}

/** The credential as the renderer and `credentials-list` may see it — every field but the value. */
function toInfo(entry: StoredCredential): CredentialInfo {
  return {
    name: entry.name,
    host: entry.host,
    account: entry.account,
    description: entry.description,
    lastUsed: entry.lastUsed
  };
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/**
 * What agents asked for with `tet-ctl credentials-request`, global to every project. A value leaves
 * this class only decrypted into `credentials-get`; the renderer never sees one.
 *
 * Read from the file on every call, never held: the file is small and rarely asked for, and what
 * changed it from outside (a second window, an import) is neither hidden nor overwritten.
 */
export class CredentialStore {
  private readonly file: string;

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, "credentials.json");
  }

  list(): CredentialInfo[] {
    return this.read().map(toInfo);
  }

  info(name: string): CredentialInfo | undefined {
    const entry = this.read().find((credential) => credential.name === name);
    return entry && toInfo(entry);
  }

  /** The decrypted value, remembered as used; undefined when there is none or it cannot be decrypted. */
  get(name: string): string | undefined {
    const credentials = this.read();
    const entry = credentials.find((credential) => credential.name === name);
    if (!entry) {
      return undefined;
    }
    let value: string;
    try {
      value = safeStorage.decryptString(Buffer.from(entry.value, "base64"));
    } catch {
      // Encrypted under a keychain this machine no longer has; the value must be asked for again.
      return undefined;
    }
    entry.lastUsed = Date.now();
    this.write(credentials);
    return value;
  }

  /**
   * Adds the credential, or replaces what is stored under its name — never two rows. Throws before
   * changing anything when the OS offers no encryption — on Linux without a keyring, where
   * safeStorage would fall back to a fixed key.
   */
  set(name: string, host: string | undefined, account: string | undefined, description: string | undefined, value: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("The OS offers no encryption to store a credential with (on Linux: no keyring)");
    }
    const stored: StoredCredential = {
      name,
      host: host || undefined,
      account: account || undefined,
      description: description || undefined,
      value: safeStorage.encryptString(value).toString("base64")
    };
    this.write([...this.read().filter((credential) => credential.name !== name), stored]);
  }

  /** False when there was nothing under the name. */
  remove(name: string): boolean {
    const credentials = this.read();
    const kept = credentials.filter((credential) => credential.name !== name);
    if (kept.length === credentials.length) {
      return false;
    }
    this.write(kept);
    return true;
  }

  private read(): StoredCredential[] {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(parsed)
        ? parsed.filter(
            (entry): entry is StoredCredential =>
              typeof entry === "object" &&
              entry !== null &&
              typeof (entry as StoredCredential).name === "string" &&
              typeof (entry as StoredCredential).value === "string" &&
              optionalString((entry as StoredCredential).host) &&
              optionalString((entry as StoredCredential).account) &&
              optionalString((entry as StoredCredential).description) &&
              ((entry as StoredCredential).lastUsed === undefined || typeof (entry as StoredCredential).lastUsed === "number")
          )
        : [];
    } catch {
      // No file yet, or unreadable — no credentials.
      return [];
    }
  }

  private write(credentials: StoredCredential[]): void {
    try {
      // Renamed into place: `read` takes a half-written file as no credentials, and the next write would keep that.
      writeFileAtomic.sync(this.file, JSON.stringify(credentials, null, 2), "utf8");
    } catch (error) {
      console.error("[tet] could not persist credentials:", error);
    }
  }
}

/** What `credentials-request` passes on: everything the dialog shows but what this class adds. */
export type CredentialAsk = Omit<CredentialRequest, "id" | "replace">;

/** The slice the control server's verbs use: the store plus the dialog (CredentialRequests.ask). */
export interface CredentialAccess {
  list(): CredentialInfo[];
  info(name: string): CredentialInfo | undefined;
  get(name: string): string | undefined;
  remove(name: string): boolean;
  ask(ask: CredentialAsk, gone: AbortSignal): Promise<string | undefined>;
}

/**
 * The credential dialog's questions, one at a time: a second agent asking waits for the first
 * answer, so the window never shows two. The dialog saves through `answer` itself, so a failure
 * stays in it (a question runs its own answer); the asking verb learns only saved or not.
 */
export class CredentialRequests {
  private lastId = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private open: { id: number; name: string; host?: string; settle: (saved: string | undefined) => void } | undefined;

  /**
   * @param show puts a request in front of the user; false when no window listens yet.
   * @param withdraw takes an open request off the screen — its caller is gone.
   */
  constructor(
    private readonly store: CredentialStore,
    private readonly show: (request: CredentialRequest) => boolean,
    private readonly withdraw: (id: number) => void
  ) {}

  /** Resolves the name saved under — the user may have changed it — or undefined on Cancel or once
   *  `gone` aborts. */
  ask(ask: CredentialAsk, gone: AbortSignal): Promise<string | undefined> {
    const turn = this.queue.then(() => this.put(ask, gone));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  /** The dialog's Save (values) or Cancel (null); a string is why it could not be saved. */
  answer(id: number, answer: CredentialAnswer | null): string | undefined {
    const open = this.open;
    if (open?.id !== id) {
      // Withdrawn while the user typed: nothing waits for it any more.
      return undefined;
    }
    if (!answer) {
      open.settle(undefined);
      return undefined;
    }
    // A replaced credential keeps its name and host: another host is another credential.
    const replacing = open.host !== undefined;
    const name = replacing ? open.name : answer.name.trim();
    if (name === "") {
      return "A credential needs a name";
    }
    if (!replacing && this.store.info(name)) {
      return `A credential named ${name} exists already`;
    }
    try {
      this.store.set(
        name,
        replacing ? open.host : answer.host.trim(),
        answer.account.trim(),
        answer.description.trim(),
        answer.value
      );
    } catch (error) {
      return errorMessage(error);
    }
    open.settle(name);
    return undefined;
  }

  /** The window reloaded: its dialog is gone, so the open request is answered as cancelled. */
  drop(): void {
    this.open?.settle(undefined);
  }

  private put(ask: CredentialAsk, gone: AbortSignal): Promise<string | undefined> {
    if (gone.aborted) {
      return Promise.resolve(undefined);
    }
    const stored = this.store.info(ask.name);
    this.lastId += 1;
    const request: CredentialRequest = stored
      ? {
          ...ask,
          id: this.lastId,
          host: stored.host,
          account: ask.account ?? stored.account,
          description: ask.description ?? stored.description,
          replace: true
        }
      : { ...ask, id: this.lastId, replace: false };
    if (!this.show(request)) {
      throw new Error("TET's window is not ready to ask; try again once it shows the workspace");
    }
    return new Promise((resolve) => {
      const cancel = (): void => {
        this.withdraw(request.id);
        settle(undefined);
      };
      const settle = (saved: string | undefined): void => {
        gone.removeEventListener("abort", cancel);
        this.open = undefined;
        resolve(saved);
      };
      gone.addEventListener("abort", cancel, { once: true });
      this.open = { id: request.id, name: request.name, host: stored ? (stored.host ?? "") : undefined, settle };
    });
  }
}
