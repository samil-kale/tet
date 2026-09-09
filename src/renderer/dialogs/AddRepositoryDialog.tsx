import { useEffect, useRef, useState } from "react";
import type {
  AddRepositoryResult,
  Project,
  ProviderAccount,
  ProviderId,
  RemoteRepository
} from "../../shared/types";
import { confirm } from "../ui/Dialog";
import { DialogFrame } from "../ui/DialogFrame";
import { Dropdown } from "../ui/Dropdown";
import { CloseIcon, PlusIcon, SpinnerIcon } from "../ui/icons";
import { notify } from "../ui/Notices";
import { useEscape } from "../ui/use-escape";

/** The four ways a repository comes in: picked off an account's list, cloned from a url, added
 *  from the filesystem, or created empty. Not part of Dialog.tsx, which puts one question. */
type Mode = "remote" | "clone" | "add" | "create";

const MODES: { id: Mode; label: string }[] = [
  { id: "remote", label: "Remote" },
  { id: "clone", label: "Clone" },
  { id: "add", label: "Add" },
  { id: "create", label: "Create" }
];

const PROVIDER_LABEL: Record<ProviderId, string> = { github: "GitHub", gitlab: "GitLab" };
const DEFAULT_HOST: Record<ProviderId, string> = { github: "github.com", gitlab: "gitlab.com" };

/** The folder a url clones into: git's own rule, the last path segment without ".git". */
function cloneFolder(url: string): string {
  const segment = url.replace(/[/\\]+$/, "").split(/[/\\:]/).pop() ?? "";
  return segment.replace(/\.git$/, "");
}

/** The host an http url names, and "" for anything that is not one. */
function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host;
  } catch {
    return "";
  }
}

/** Which of the two a host is likely to be. A guess: a self-hosted one gives nothing away. */
function guessProvider(host: string): ProviderId {
  return host.includes("gitlab") ? "gitlab" : "github";
}

/** Which host family a token belongs to — each is validated against its own API. */
function ProviderPicker({ provider, onPick }: { provider: ProviderId; onPick: (provider: ProviderId) => void }) {
  return (
    <div className="dialog-field">
      <span>Provider</span>
      <div className="dialog-field-row">
        {(Object.keys(PROVIDER_LABEL) as ProviderId[]).map((id) => (
          <button
            key={id}
            type="button"
            className={provider === id ? "button" : "button secondary"}
            onClick={() => onPick(id)}
          >
            {PROVIDER_LABEL[id]}
          </button>
        ))}
      </div>
    </div>
  );
}

interface PathFieldProps {
  label: string;
  value: string;
  /** The native picker's window title, which is all the picker says about why it is open. */
  pickTitle: string;
  onChange: (value: string) => void;
  /** Where the dialog's focus effect reaches the input, when this is a mode's first field. */
  inputRef?: React.Ref<HTMLInputElement>;
}

/** The folder the picker opens in when the field is empty. Kept in the renderer's own storage:
 *  it describes how this window is used, not any one project; every such field shares it. */
const LAST_DIRECTORY_KEY = "tet.dialog.lastDirectory";

function PathField({ label, value, pickTitle, onChange, inputRef }: PathFieldProps) {
  const browse = async (): Promise<void> => {
    // What the field already names comes first, being the more specific answer.
    const start = value.trim() || localStorage.getItem(LAST_DIRECTORY_KEY) || undefined;
    const picked = await window.tet.projects.pickDirectory(pickTitle, start);
    if (picked) {
      // A folder that is itself a repository is not where the picker opens next; its parent is.
      localStorage.setItem(LAST_DIRECTORY_KEY, await window.tet.projects.directoryToRemember(picked));
      onChange(picked);
    }
  };
  return (
    <label className="dialog-field">
      <span>{label}</span>
      <div className="dialog-field-row">
        <input type="text" value={value} onChange={(event) => onChange(event.target.value)} ref={inputRef} />
        <button type="button" className="button secondary" onClick={() => void browse()}>
          Browse...
        </button>
      </div>
    </label>
  );
}

interface AccountFormProps {
  onAdded: (account: ProviderAccount) => void;
}

/** Provider, host and token; the token is validated on the way in and never shown again. */
function AccountForm({ onAdded }: AccountFormProps) {
  const [provider, setProvider] = useState<ProviderId>("github");
  const [host, setHost] = useState(DEFAULT_HOST.github);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  /** Switching the provider replaces the host only while it is still the other one's default. */
  const pick = (next: ProviderId): void => {
    setProvider(next);
    setHost((current) =>
      current === "" || current === DEFAULT_HOST.github || current === DEFAULT_HOST.gitlab
        ? DEFAULT_HOST[next]
        : current
    );
  };

  const canSubmit = host.trim() !== "" && token.trim() !== "" && !busy;

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await window.tet.providers.addAccount(provider, host.trim(), token.trim());
      if (result.account) {
        onAdded(result.account);
      } else {
        notify("error", result.error ?? "The account could not be added");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="account-form">
      <ProviderPicker provider={provider} onPick={pick} />
      <label className="dialog-field">
        <span>Host</span>
        <input type="text" value={host} onChange={(event) => setHost(event.target.value)} />
      </label>
      <label className="dialog-field">
        <span>Personal access token</span>
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          // Enter here means this form, not the dialog's.
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (canSubmit) {
                void submit();
              }
            }
          }}
        />
      </label>
      {/* Its own row rather than the dialog's, whose Cancel closes the whole thing. */}
      <div className="dialog-buttons">
        <button
          type="button"
          className="button"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {busy && <SpinnerIcon className="spinning" />}
          <span>Add account</span>
        </button>
      </div>
    </div>
  );
}

/** Everything before the last segment of a full name: the group or owner it sits in. */
function namespaceOf(fullName: string): string {
  const cut = fullName.lastIndexOf("/");
  return cut === -1 ? "" : fullName.slice(0, cut);
}

interface Namespace {
  path: string;
  /** How many repositories the entry covers, everything below it included. */
  count: number;
  /** How far the path is nested, which is what the entry is indented by. */
  depth: number;
}

/** The filter's entries: every level of every namespace, whether or not a repository sits in one
 *  directly. A GitLab group nests several deep and picking it covers its subgroups, so the
 *  counting goes by prefix and a parent's number is the sum below it. */
function namespacesOf(repos: RemoteRepository[]): Namespace[] {
  const counts = new Map<string, number>();
  for (const repo of repos) {
    const segments = namespaceOf(repo.fullName).split("/").filter((segment) => segment !== "");
    for (let end = 1; end <= segments.length; end++) {
      const path = segments.slice(0, end).join("/");
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, count]) => ({ path, count, depth: path.split("/").length - 1 }));
}

/** In a namespace means in it or in anything below it, never merely starting with its name. */
function inNamespace(fullName: string, namespace: string): boolean {
  const own = namespaceOf(fullName);
  return own === namespace || own.startsWith(`${namespace}/`);
}

interface RemoteTabProps {
  /** Jumps to the clone tab with the repository's url, name and account filled in. */
  onClone: (repo: RemoteRepository, accountId: string) => void;
}

function RemoteTab({ onClone }: RemoteTabProps) {
  /** null while the stored accounts are still being asked for. */
  const [accounts, setAccounts] = useState<ProviderAccount[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Loaded lists by account, for the lifetime of the dialog. */
  const [repos, setRepos] = useState<Record<string, RemoteRepository[]>>({});
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  /** The group picked in this dialog, "" for all of them; null while none was picked here. */
  const [namespace, setNamespace] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void window.tet.providers.accounts().then((list) => {
      setAccounts(list);
      setSelectedId(list[0]?.id ?? null);
      // Straight into the form when there is nothing yet.
      setAdding(list.length === 0);
    });
  }, []);

  // The groups are the listed account's own, so a pick made in another would filter this list
  // to nothing. Back to null rather than "": the next account opens at its own stored group.
  useEffect(() => {
    setNamespace(null);
  }, [selectedId]);

  useEffect(() => {
    if (selectedId === null || repos[selectedId]) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    void window.tet.providers.repos(selectedId).then((result) => {
      if (cancelled) {
        return;
      }
      setLoading(false);
      const list = result.repos;
      if (list) {
        setRepos((current) => ({ ...current, [selectedId]: list }));
      } else {
        notify("error", result.error ?? "The repositories could not be listed");
      }
    });
    return () => {
      cancelled = true;
      // The next run only turns it back on when it fetches, so switching to an already-listed
      // account leaves no spinner standing over that list.
      setLoading(false);
    };
  }, [selectedId, repos]);

  const accountAdded = (account: ProviderAccount): void => {
    // Replacing, not just appending: entering a fresh token answers with the same account id.
    setAccounts((current) => [
      ...(current ?? []).filter((entry) => entry.id !== account.id),
      account
    ]);
    // A re-entered token may reach further than the old one did, so the cached list is stale.
    setRepos((current) => {
      const next = { ...current };
      delete next[account.id];
      return next;
    });
    setSelectedId(account.id);
    setAdding(false);
  };

  const removeAccount = async (account: ProviderAccount): Promise<void> => {
    const answer = await confirm({
      title: "Remove account",
      message: `Remove ${account.user} on ${account.host}?`,
      detail: "The stored token is deleted with it.",
      confirmLabel: "Remove"
    });
    if (!answer.confirmed) {
      return;
    }
    await window.tet.providers.removeAccount(account.id);
    const remaining = (accounts ?? []).filter((entry) => entry.id !== account.id);
    setAccounts(remaining);
    setSelectedId((current) => (current === account.id ? (remaining[0]?.id ?? null) : current));
  };

  /** Keeps the pick with the account it was made in, so the tab opens there next time. */
  const pickNamespace = (next: string): void => {
    setNamespace(next);
    if (selectedId !== null) {
      setAccounts((current) =>
        (current ?? []).map((entry) => (entry.id === selectedId ? { ...entry, namespace: next } : entry))
      );
      void window.tet.providers.setNamespace(selectedId, next);
    }
  };

  const list = selectedId !== null ? repos[selectedId] : undefined;
  const query = filter.trim().toLowerCase();
  const groups = namespacesOf(list ?? []);
  /** What the dropdown stands at: this dialog's pick, else the account's stored group, else the
   *  first row's (the list arrives sorted by recent activity). Back to all of them only when a
   *  stored group is gone from the list, where it would filter everything away. */
  const stored = (accounts ?? []).find((entry) => entry.id === selectedId)?.namespace;
  const wanted = namespace ?? stored ?? (list?.[0] ? namespaceOf(list[0].fullName) : "");
  const active = wanted === "" || groups.some((group) => group.path === wanted) ? wanted : "";
  const filtered = (list ?? []).filter(
    (repo) => repo.fullName.toLowerCase().includes(query) && (active === "" || inNamespace(repo.fullName, active))
  );

  return (
    <div className="remote-tab">
      <div className="account-list">
        {(accounts ?? []).map((account) => (
          <div
            key={account.id}
            className={account.id === selectedId && !adding ? "account-item active" : "account-item"}
            onClick={() => {
              setSelectedId(account.id);
              setAdding(false);
            }}
          >
            <div className="account-label">
              <span className="account-user">{account.user}</span>
              <span className="account-host">
                {PROVIDER_LABEL[account.provider]} · {account.host}
              </span>
            </div>
            <button
              className="icon-button"
              title="Remove account"
              onClick={(event) => {
                event.stopPropagation();
                void removeAccount(account);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
        <button type="button" className="add-account" onClick={() => setAdding(true)}>
          <PlusIcon />
          <span>Add account...</span>
        </button>
      </div>
      <div className="remote-main">
        {adding ? (
          <AccountForm onAdded={accountAdded} />
        ) : selectedId === null ? (
          <div className="placeholder">No account yet — add one to browse its repositories.</div>
        ) : (
          <>
            <input
              type="text"
              placeholder="Search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            {/* Only once there is something to narrow down to. */}
            {groups.length > 1 && (
              <Dropdown
                value={active}
                onChange={pickNamespace}
                options={[
                  { value: "", label: `All repositories (${list?.length ?? 0})` },
                  ...groups.map((group) => ({
                    value: group.path,
                    // Non-breaking, since a leading plain space in the rendered label is collapsed.
                    label: `${"\u00a0\u00a0".repeat(group.depth)}${group.path} (${group.count})`
                  }))
                ]}
              />
            )}
            <div className="repository-list">
              {loading && (
                <div className="repository-loading">
                  <SpinnerIcon className="spinning" />
                </div>
              )}
              {!loading &&
                filtered.map((repo) => (
                  <div className="repository-item" key={repo.fullName}>
                    <span className="repository-name">{repo.fullName}</span>
                    {repo.private && <span className="repository-private">Private</span>}
                    <button
                      type="button"
                      className="button secondary repository-clone"
                      onClick={() => onClone(repo, selectedId)}
                    >
                      Clone
                    </button>
                  </div>
                ))}
              {!loading && list && filtered.length === 0 && <div className="placeholder">No repositories.</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

type CloneAuthMode = "account" | "token";

interface CloneAuthProps {
  /** The stored accounts for this url's own host; a token for another host is no use here. */
  accounts: ProviderAccount[];
  /** Already resolved: "token" whenever there is no account to pick, whatever was switched to. */
  mode: CloneAuthMode;
  onMode: (mode: CloneAuthMode) => void;
  accountId: string | null;
  onAccount: (accountId: string) => void;
  provider: ProviderId;
  onProvider: (provider: ProviderId) => void;
  token: string;
  onToken: (token: string) => void;
}

/** How to authenticate a clone that came back asking for credentials: a stored account, or a
 *  token typed in now and kept as an account. Drawn only when there is an account to pick. */
function CloneAuth({
  accounts,
  mode,
  onMode,
  accountId,
  onAccount,
  provider,
  onProvider,
  token,
  onToken
}: CloneAuthProps) {
  return (
    <>
      {accounts.length > 0 && (
        <div className="dialog-field">
          <span>Authenticate with</span>
          <div className="dialog-field-row">
            <button
              type="button"
              className={mode === "account" ? "button" : "button secondary"}
              onClick={() => onMode("account")}
            >
              Account
            </button>
            <button
              type="button"
              className={mode === "token" ? "button" : "button secondary"}
              onClick={() => onMode("token")}
            >
              Token
            </button>
          </div>
        </div>
      )}
      {mode === "account" ? (
        <div className="dialog-field">
          <span>Account</span>
          <div className="dialog-field-row">
            {accounts.map((account) => (
              <button
                key={account.id}
                type="button"
                className={account.id === accountId ? "button" : "button secondary"}
                onClick={() => onAccount(account.id)}
              >
                {account.user}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <ProviderPicker provider={provider} onPick={onProvider} />
          <label className="dialog-field">
            <span>Personal access token</span>
            <input type="password" value={token} onChange={(event) => onToken(event.target.value)} />
          </label>
        </>
      )}
    </>
  );
}

interface AddRepositoryDialogProps {
  onAdded: (project: Project) => void;
  onClose: () => void;
}

export function AddRepositoryDialog({ onAdded, onClose }: AddRepositoryDialogProps) {
  const [mode, setMode] = useState<Mode>("remote");
  const [url, setUrl] = useState("");
  /** Where the new folder goes (clone and create); the folder that already exists (add). */
  const [directory, setDirectory] = useState("");
  /** null follows the url; a string is the user's own and stays. */
  const [name, setName] = useState<string | null>(null);
  /** The account whose token authenticates the clone: the remote tab's row, or CloneAuth's pick. */
  const [accountId, setAccountId] = useState<string | null>(null);
  /** The credentials block: null until a clone asked for credentials, then this host's own
   *  accounts, of which there may be none. */
  const [authAccounts, setAuthAccounts] = useState<ProviderAccount[] | null>(null);
  const [authMode, setAuthMode] = useState<CloneAuthMode>("account");
  const [token, setToken] = useState("");
  const [tokenProvider, setTokenProvider] = useState<ProviderId>("github");
  const [busy, setBusy] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);

  // The focus lands in the first field of the mode on screen.
  useEffect(() => {
    firstField.current?.focus();
  }, [mode]);

  useEscape(onClose);

  const folderName = name ?? cloneFolder(url.trim());
  // With no account for this host the token applies however the switch stands.
  const authWith: CloneAuthMode = authAccounts?.length ? authMode : "token";
  /** Nothing to answer while the block is down; once it is up, its half has to be filled in. */
  const authAnswered =
    authAccounts === null || (authWith === "token" ? token.trim() !== "" : accountId !== null);
  const ready =
    mode === "clone"
      ? url.trim() !== "" && directory.trim() !== "" && folderName.trim() !== "" && authAnswered
      : mode === "add"
        ? directory.trim() !== ""
        : mode === "create"
          ? directory.trim() !== "" && folderName.trim() !== ""
          : false;

  /** Puts the credentials block up: this host's accounts, and a provider guessed from its name
   *  for the token half. Asked for when needed rather than kept current. */
  const askForCredentials = async (): Promise<void> => {
    const host = hostOf(url);
    const stored = await window.tet.providers.accounts();
    const matching = stored.filter((account) => account.host === host);
    setAuthAccounts(matching);
    setAccountId(matching[0]?.id ?? null);
    setAuthMode("account");
    setTokenProvider(guessProvider(host));
  };

  const cloneRepository = async (): Promise<AddRepositoryResult> => {
    let id = accountId ?? undefined;
    if (authAccounts !== null && authWith === "token") {
      // Validated and stored on the way through: the same call replaces an expired account's
      // token, and one the host rejects fails here, before git is run again.
      const added = await window.tet.providers.addAccount(tokenProvider, hostOf(url), token.trim());
      if (!added.account) {
        return { error: added.error ?? "The token could not be verified", authRequired: true };
      }
      id = added.account.id;
    }
    return window.tet.projects.clone(url.trim(), directory.trim(), folderName.trim(), id);
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const result =
        mode === "add"
          ? await window.tet.projects.open(directory.trim())
          : mode === "clone"
            ? await cloneRepository()
            : await window.tet.projects.create(directory.trim(), folderName.trim());
      if (result.project) {
        onAdded(result.project);
        onClose();
        return;
      }
      notify("error", result.error ?? "The repository could not be added");
      // Only on the way in: a second failure must not throw away what was typed.
      if (result.authRequired && authAccounts === null) {
        await askForCredentials();
      }
    } finally {
      setBusy(false);
    }
  };

  // Fields keep what was typed across a tab switch; only the name resets, only clone deriving it.
  const switchMode = (next: Mode): void => {
    setMode(next);
    setName(null);
  };

  /** A remote row's Clone: the clone tab, filled in, with the account's token along. */
  const cloneFromRemote = (repo: RemoteRepository, fromAccountId: string): void => {
    setUrl(repo.cloneUrl);
    setName(repo.name);
    setAccountId(fromAccountId);
    // A block a previous url put up would hold this clone back for a token and use that instead
    // of the row's own account.
    setAuthAccounts(null);
    setToken("");
    setMode("clone");
  };

  return (
    <DialogFrame
      header={{ tabs: MODES, active: mode, onSelect: switchMode }}
      className="add-repository-dialog"
      onSubmit={() => {
        if (ready && !busy) {
          void submit();
        }
      }}
      buttons={
        <>
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          {mode !== "remote" && (
            <button type="submit" className="button" disabled={!ready || busy}>
              {busy && <SpinnerIcon className="spinning" />}
              <span>{MODES.find((entry) => entry.id === mode)?.label}</span>
            </button>
          )}
        </>
      }
    >
      {mode === "remote" && <RemoteTab onClone={cloneFromRemote} />}
      {mode === "clone" && (
        <>
          <label className="dialog-field">
            <span>Repository URL</span>
            <input
              type="text"
              value={url}
              placeholder="https://github.com/owner/repository.git"
              onChange={(event) => {
                setUrl(event.target.value);
                // Edited by hand: the remote tab's account must not be offered to a new host.
                setAccountId(null);
                setAuthAccounts(null);
                setToken("");
              }}
              ref={firstField}
            />
          </label>
          <PathField label="Destination" value={directory} pickTitle="Clone into" onChange={setDirectory} />
          <label className="dialog-field">
            <span>Folder name</span>
            <input type="text" value={folderName} onChange={(event) => setName(event.target.value)} />
          </label>
          {authAccounts !== null && (
            <CloneAuth
              accounts={authAccounts}
              mode={authWith}
              onMode={setAuthMode}
              accountId={accountId}
              onAccount={setAccountId}
              provider={tokenProvider}
              onProvider={setTokenProvider}
              token={token}
              onToken={setToken}
            />
          )}
        </>
      )}
      {mode === "add" && (
        <PathField
          label="Repository path"
          value={directory}
          pickTitle="Add repository"
          onChange={setDirectory}
          inputRef={firstField}
        />
      )}
      {mode === "create" && (
        <>
          <PathField
            label="Destination"
            value={directory}
            pickTitle="Create in"
            onChange={setDirectory}
            inputRef={firstField}
          />
          <label className="dialog-field">
            <span>Folder name</span>
            <input type="text" value={folderName} onChange={(event) => setName(event.target.value)} />
          </label>
        </>
      )}
    </DialogFrame>
  );
}
