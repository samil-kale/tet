import { useEffect, useRef, useState } from "react";
import type {
  AddRepositoryResult,
  GitLogin,
  Project,
  ProviderAccount,
  ProviderId,
  RemoteRepository
} from "../../shared/types";
import { emptyLogin, GitLoginFields, loginReady } from "../git/GitLogin";
import { ActionLink } from "../ui/ActionLink";
import { confirm } from "../ui/Dialog";
import { DialogFrame } from "../ui/DialogFrame";
import { Dropdown } from "../ui/Dropdown";
import { DialogError, Field, TextField } from "../ui/Field";
import { FilterField } from "../ui/FilterField";
import { CloseIcon } from "../ui/icons";
import { RadioGroup } from "../ui/RadioGroup";
import { useEscape } from "../ui/use-escape";

/** Picked off an account's list, cloned from a url, added from disk, or created empty. Not in
 *  Dialog.tsx, which asks one question. */
type Mode = "remote" | "clone" | "add" | "create";

const MODES: { id: Mode; label: string }[] = [
  { id: "remote", label: "Remote" },
  { id: "clone", label: "Clone" },
  { id: "add", label: "Add" },
  { id: "create", label: "Create" }
];

const PROVIDER_LABEL: Record<ProviderId, string> = { github: "GitHub", gitlab: "GitLab" };
const DEFAULT_HOST: Record<ProviderId, string> = { github: "github.com", gitlab: "gitlab.com" };
const PROVIDER_OPTIONS = (Object.keys(PROVIDER_LABEL) as ProviderId[]).map((value) => ({
  value,
  label: PROVIDER_LABEL[value]
}));

/** The folder a url clones into, by git's rule: the last path segment without ".git". */
function cloneFolder(url: string): string {
  const segment = url.replace(/[/\\]+$/, "").split(/[/\\:]/).pop() ?? "";
  return segment.replace(/\.git$/, "");
}

/** Which provider a token is for; each validates against its own API. */
function ProviderPicker({ provider, onPick }: { provider: ProviderId; onPick: (provider: ProviderId) => void }) {
  return (
    <div className="dialog-field">
      <span>Provider</span>
      <RadioGroup value={provider} options={PROVIDER_OPTIONS} onChange={onPick} />
    </div>
  );
}

interface PathFieldProps {
  label: string;
  value: string;
  /** The native picker's window title. */
  pickTitle: string;
  onChange: (value: string) => void;
  /** For the dialog's focus effect, when this is a mode's first field. */
  inputRef?: React.Ref<HTMLInputElement>;
}

/** Where the picker opens for an empty field. Renderer storage, shared by every such field: it
 *  describes this window's use, not a project. */
const LAST_DIRECTORY_KEY = "tet.dialog.lastDirectory";

function PathField({ label, value, pickTitle, onChange, inputRef }: PathFieldProps) {
  const browse = async (): Promise<void> => {
    // The field's own value is more specific, so it wins.
    const start = value.trim() || localStorage.getItem(LAST_DIRECTORY_KEY) || undefined;
    const picked = await window.tet.projects.pickDirectory(pickTitle, start);
    if (picked) {
      // A picked repository's parent is where the picker opens next.
      localStorage.setItem(LAST_DIRECTORY_KEY, await window.tet.projects.directoryToRemember(picked));
      onChange(picked);
    }
  };
  return (
    <Field label={label}>
      <div className="dialog-field-row">
        <input type="text" value={value} onChange={(event) => onChange(event.target.value)} ref={inputRef} />
        <button type="button" className="button secondary" onClick={() => void browse()}>
          Browse...
        </button>
      </div>
    </Field>
  );
}

interface AccountFormProps {
  onAdded: (account: ProviderAccount) => void;
  /** Held by the dialog: the header's progress bar is the only one. */
  busy: boolean;
  onBusy: (busy: boolean) => void;
}

/** Provider, host and token; the token is validated on entry and never shown again. */
function AccountForm({ onAdded, busy, onBusy }: AccountFormProps) {
  const [provider, setProvider] = useState<ProviderId>("github");
  const [host, setHost] = useState(DEFAULT_HOST.github);
  const [token, setToken] = useState("");
  /** What the host refused, above this form's own buttons: the token is checked against the host,
   *  so neither field alone can be blamed. Cleared by the next edit of either. */
  const [refused, setRefused] = useState<string | undefined>(undefined);

  /** Replaces the host only while it is empty or a provider default. */
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
    onBusy(true);
    setRefused(undefined);
    try {
      const result = await window.tet.providers.addAccount(provider, host.trim(), token.trim());
      if (result.account) {
        onAdded(result.account);
      } else {
        setRefused(result.error ?? "The account could not be added");
      }
    } finally {
      onBusy(false);
    }
  };

  return (
    <div className="account-form">
      <ProviderPicker provider={provider} onPick={pick} />
      <TextField
        label="Host"
        value={host}
        onChange={(next) => {
          setHost(next);
          setRefused(undefined);
        }}
      />
      <TextField
        label="Personal access token"
        type="password"
        value={token}
        onChange={(next) => {
          setToken(next);
          setRefused(undefined);
        }}
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
      <DialogError message={refused} />
      {/* Its own row: the dialog's Cancel closes the whole dialog. */}
      <div className="dialog-buttons">
        <button
          type="button"
          className="button"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          Add account
        </button>
      </div>
    </div>
  );
}

/** A full name's group or owner: everything before the last segment. */
function namespaceOf(fullName: string): string {
  const cut = fullName.lastIndexOf("/");
  return cut === -1 ? "" : fullName.slice(0, cut);
}

interface Namespace {
  path: string;
  /** Repositories covered, subgroups included. */
  count: number;
  /** Nesting level, the entry's indent. */
  depth: number;
}

/** The filter's entries: every level of every namespace, even one holding no repository directly.
 *  A GitLab group nests and covers its subgroups, so counts go by prefix. */
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

/** In the namespace or below it — not merely sharing its name as a prefix. */
function inNamespace(fullName: string, namespace: string): boolean {
  const own = namespaceOf(fullName);
  return own === namespace || own.startsWith(`${namespace}/`);
}

interface RemoteTabProps {
  /** Opens the clone tab with url, name and account filled in. */
  onClone: (repo: RemoteRepository, accountId: string) => void;
  /** See AccountFormProps. */
  busy: boolean;
  onBusy: (busy: boolean) => void;
}

function RemoteTab({ onClone, busy, onBusy }: RemoteTabProps) {
  /** null while loading. */
  const [accounts, setAccounts] = useState<ProviderAccount[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Loaded lists by account, kept while the dialog is open. */
  const [repos, setRepos] = useState<Record<string, RemoteRepository[]>>({});
  /** Why the list is empty, in the list's own place. */
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState("");
  /** The group picked in this dialog, "" for all; null while none was picked here. */
  const [namespace, setNamespace] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void window.tet.providers.accounts().then((list) => {
      setAccounts(list);
      setSelectedId(list[0]?.id ?? null);
      // Straight into the form when there is no account.
      setAdding(list.length === 0);
    });
  }, []);

  // Groups are per account, so a pick would filter another's list to nothing. null, not "", so
  // the next account opens at its stored group.
  useEffect(() => {
    setNamespace(null);
  }, [selectedId]);

  useEffect(() => {
    // Another account's failure is not this one's.
    setListError(undefined);
    if (selectedId === null || repos[selectedId]) {
      return;
    }
    let cancelled = false;
    let fetching = true;
    onBusy(true);
    void window.tet.providers
      .repos(selectedId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        const list = result.repos;
        if (list) {
          setRepos((current) => ({ ...current, [selectedId]: list }));
          setListError(undefined);
        } else {
          setListError(result.error ?? "The repositories could not be listed");
        }
      })
      .finally(() => {
        if (!cancelled) {
          fetching = false;
          onBusy(false);
        }
      });
    return () => {
      cancelled = true;
      // Only a fetch still running: the bar may be the account form's by now. The next run turns
      // it on only when it fetches, so an already-listed account shows none.
      if (fetching) {
        onBusy(false);
      }
    };
  }, [selectedId, repos, onBusy]);

  const accountAdded = (account: ProviderAccount): void => {
    // Replace, not append: a fresh token answers with the same account id.
    setAccounts((current) => [
      ...(current ?? []).filter((entry) => entry.id !== account.id),
      account
    ]);
    // A re-entered token may reach further, so the cached list is stale.
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

  /** Stores the pick on its account, so the tab opens there next time. */
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
  /** The dropdown's value: this dialog's pick, else the stored group, else the first row's (the
   *  list is sorted by recent activity). "All" only when that group is gone from the list. */
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
        <div className="account-add">
          <ActionLink onClick={() => setAdding(true)}>+ Add account...</ActionLink>
        </div>
      </div>
      <div className="remote-main">
        {adding ? (
          <AccountForm onAdded={accountAdded} busy={busy} onBusy={onBusy} />
        ) : selectedId === null ? (
          <div className="placeholder">No account yet — add one to browse its repositories.</div>
        ) : (
          <>
            <FilterField placeholder="Search" value={filter} onChange={setFilter} />
            {/* Only with more than one group. */}
            {groups.length > 1 && (
              <Dropdown
                value={active}
                onChange={pickNamespace}
                options={[
                  { value: "", label: `All repositories (${list?.length ?? 0})` },
                  ...groups.map((group) => ({
                    value: group.path,
                    // Non-breaking: leading plain spaces collapse.
                    label: `${"\u00a0\u00a0".repeat(group.depth)}${group.path} (${group.count})`
                  }))
                ]}
              />
            )}
            <div className="repository-list">
              {filtered.map((repo) => (
                <div className="repository-item" key={repo.fullName}>
                  <span className="repository-name">{repo.fullName}</span>
                  <button
                    type="button"
                    className="button secondary repository-clone"
                    onClick={() => onClone(repo, selectedId)}
                  >
                    Clone
                  </button>
                </div>
              ))}
              <DialogError message={listError} />
              {listError === undefined && list && filtered.length === 0 && (
                <div className="placeholder">No repositories.</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface AddRepositoryDialogProps {
  onAdded: (project: Project) => void;
  onClose: () => void;
}

/** The one place tet talks to a host rather than a repository, so provider accounts live here. */
export function AddRepositoryDialog({ onAdded, onClose }: AddRepositoryDialogProps) {
  const [mode, setMode] = useState<Mode>("remote");
  const [url, setUrl] = useState("");
  /** The parent of the new folder (clone, create), or the existing folder (add). */
  const [directory, setDirectory] = useState("");
  /** null follows the url; a string is the user's and stays. */
  const [name, setName] = useState<string | null>(null);
  /** The account authenticating the clone: the remote tab's row. */
  const [accountId, setAccountId] = useState<string | null>(null);
  /** null until a clone wanted a login (`loginUrl`), then the url it wants one for. */
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [login, setLogin] = useState<GitLogin>({ username: "", password: "" });
  const [busy, setBusy] = useState(false);
  /** What refused the add, above the buttons: which field is to blame depends on the tab — a url,
   *  a path, a folder name — so none of them carries it. Cleared on the next try and on a tab
   *  switch, both of which make it wrong. */
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const firstField = useRef<HTMLInputElement>(null);
  const loginField = useRef<HTMLInputElement>(null);

  // Focus the current mode's first field.
  useEffect(() => {
    firstField.current?.focus();
  }, [mode]);

  // The login's first field, once the clone asks for it.
  useEffect(() => {
    loginField.current?.focus();
  }, [loginUrl]);

  useEscape(onClose);

  const folderName = name ?? cloneFolder(url.trim());
  const ready =
    mode === "clone"
      ? url.trim() !== "" &&
        directory.trim() !== "" &&
        folderName.trim() !== "" &&
        (loginUrl === null || loginReady(login))
      : mode === "add"
        ? directory.trim() !== ""
        : mode === "create"
          ? directory.trim() !== "" && folderName.trim() !== ""
          : false;

  const cloneRepository = (): Promise<AddRepositoryResult> =>
    window.tet.projects.clone(
      url.trim(),
      directory.trim(),
      folderName.trim(),
      accountId ?? undefined,
      loginUrl === null ? undefined : { username: login.username.trim(), password: login.password }
    );

  const submit = async (): Promise<void> => {
    setBusy(true);
    setRefused(undefined);
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
      setRefused(result.error ?? "The repository could not be added");
      // Only the first time: a second failure must not discard what was typed.
      if (result.loginUrl !== undefined && loginUrl === null) {
        setLoginUrl(result.loginUrl);
        setLogin(emptyLogin(result.loginUrl));
        // An account's token the host refused: the login typed next goes in its stead.
        setAccountId(null);
      }
    } finally {
      setBusy(false);
    }
  };

  // Fields survive a tab switch; only the name resets, since only clone derives it.
  const switchMode = (next: Mode): void => {
    setMode(next);
    setName(null);
    setRefused(undefined);
  };

  /** A remote row's Clone: the clone tab filled in, with the row's account. */
  const cloneFromRemote = (repo: RemoteRepository, fromAccountId: string): void => {
    setUrl(repo.cloneUrl);
    setName(repo.name);
    setAccountId(fromAccountId);
    // A login asked for a previous url would be sent instead of the row's account.
    setLoginUrl(null);
    setMode("clone");
  };

  return (
    <DialogFrame
      header={{ tabs: MODES, active: mode, onSelect: switchMode, onClose }}
      error={refused}
      className="add-repository-dialog"
      busy={busy}
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
              {MODES.find((entry) => entry.id === mode)?.label}
            </button>
          )}
        </>
      }
    >
      {mode === "remote" && <RemoteTab onClone={cloneFromRemote} busy={busy} onBusy={setBusy} />}
      {mode === "clone" && (
        <>
          <TextField
            label="Repository URL"
            value={url}
            placeholder="https://github.com/owner/repository.git"
            onChange={(next) => {
              setUrl(next);
              // Hand-edited: the remote tab's account, or a login asked for, must not carry over to a
              // new host.
              setAccountId(null);
              setLoginUrl(null);
            }}
            ref={firstField}
          />
          <PathField label="Destination" value={directory} pickTitle="Clone into" onChange={setDirectory} />
          <TextField label="Folder name" value={folderName} onChange={setName} />
          {loginUrl !== null && (
            // Its failure shows above the buttons, as the tab's others do (`refused`).
            <GitLoginFields url={loginUrl} value={login} onChange={setLogin} busy={busy} field={loginField} />
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
          <TextField label="Folder name" value={folderName} onChange={setName} />
        </>
      )}
    </DialogFrame>
  );
}
