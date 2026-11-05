import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { IssueChange, IssueDetail, IssueMilestone, ProviderId } from "../../shared/types/providers";
import { ActionLink } from "../ui/ActionLink";
import type { AgentId, AgentInfo } from "../../shared/types/agents";
import { agentEntry } from "../ui/agent-icons";
import { BAR_MENU_DROP, useAnchoredMenu, type ContextMenuEntry } from "../ui/ContextMenu";
import { askName, confirmed } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { GearIcon, RemoteIcon, LinkIcon, PaperclipIcon, PencilIcon, SquareSparklesIcon, SyncIcon, TrashIcon } from "../ui/icons";
import { PickMenu } from "../ui/PickMenu";
import { useTextContextMenu } from "../ui/use-text-context-menu";
import { useAgents } from "../ui/use-agents";
import { issueLink } from "./editor-tab";
import { issueThread, type ThreadEvent } from "./issue-thread";
import { issueFileLink, issueTextHtml } from "./issue-text";
import { createMarkdownPreview, renderHtmlInto, resolveLink } from "./markdown";

const DAY_MS = 86_400_000;

/** The day of a time, counted from today where that says more than the date. */
export function dayOf(at: string): string {
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / DAY_MS);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : new Date(at).toLocaleDateString();
}

/** The longest unit first: a time is counted in the first it fills. */
const ELAPSED_UNITS = [
  ["week", 7 * DAY_MS],
  ["day", DAY_MS],
  ["hour", 3_600_000],
  ["minute", 60_000],
] as const;
const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** When something was written, worded as GitHub does: how long ago for 30 days, then its date, with
 *  the year where it is not this one. */
function agoOf(at: string): string {
  const date = new Date(at);
  const elapsed = Date.now() - date.getTime();
  if (elapsed >= 30 * DAY_MS) {
    const year = date.getFullYear() === new Date().getFullYear() ? undefined : "numeric";
    return `on ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year })}`;
  }
  const filled = ELAPSED_UNITS.find(([, ms]) => elapsed >= ms);
  return filled ? RELATIVE_TIME.format(-Math.floor(elapsed / filled[1]), filled[0]) : "now";
}

/** What has come of each avatar's URL, read while rendering: a row shown again draws it at once. */
const avatarImages = new Map<string, string>();
/** Each URL asked for once, however many rows name it; one that failed stays unasked until a restart. */
const avatarFetches = new Map<string, Promise<void>>();

function fetchAvatar(url: string): Promise<void> {
  let fetching = avatarFetches.get(url);
  if (!fetching) {
    fetching = window.tet.shell.fetchImage(url).then((image) => {
      if (image !== null) {
        avatarImages.set(url, image);
      }
    });
    avatarFetches.set(url, fetching);
  }
  return fetching;
}

/** Who an issue names: their picture, the login's first letters until or unless it comes, the login
 *  on hover. A picture dragged is the row it stands in. */
export function Person({ login, avatar }: { login: string; avatar: string | undefined }) {
  const [, setFetched] = useState<string>();
  useEffect(() => {
    if (avatar === undefined || avatarImages.has(avatar)) {
      return;
    }
    let current = true;
    void fetchAvatar(avatar).then(() => {
      if (current) {
        setFetched(avatar);
      }
    });
    return () => {
      current = false;
    };
  }, [avatar]);
  const image = avatar === undefined ? undefined : avatarImages.get(avatar);
  return (
    <span className="issue-person" title={login}>
      {image === undefined ? login.slice(0, 2).toUpperCase() : <img src={image} alt="" draggable={false} />}
    </span>
  );
}

type LoadImage = (source: string) => Promise<string | undefined>;

/** What the tab does, through its issue's view outside React (`editor-views.ts`). What can be refused
 *  says so in a notice, and false where what was typed then stays. */
export interface IssueActions {
  loadImage: LoadImage;
  /** A file of the repository a link of its text leads to. */
  openFile: (path: string) => void;
  refresh: () => void;
  comment: (body: string) => Promise<boolean>;
  editComment: (id: string, body: string) => Promise<boolean>;
  deleteComment: (id: string) => Promise<void>;
  deleteIssue: () => Promise<void>;
  update: (change: IssueChange) => void;
  /** The title changed; what the tracker refused, for the dialog that asked (`askName`). */
  rename: (title: string) => Promise<string | undefined>;
  options: () => Promise<{ labels: string[]; people: string[] } | undefined>;
  milestones: () => Promise<IssueMilestone[] | undefined>;
  /** The Markdown that shows the file, once it is up. */
  upload: (file: File) => Promise<string | undefined>;
  openInAgent: (agentId: AgentId) => void;
}

interface IssueTextProps {
  /** The Markdown as written. */
  text: string;
  provider: ProviderId;
  /** What a relative link leads from. */
  issueUrl: string;
  loadImage: LoadImage;
  openFile: IssueActions["openFile"];
}

/** Text written on the tracker, rendered in a shadow root of its own as the Markdown preview's is
 *  (`issueTextHtml`), before the card's first paint. A link to a file of the repository opens it; the
 *  rest go to main, which opens only web and mail ones. */
function IssueText({ text, provider, issueUrl, loadImage, openFile }: IssueTextProps) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const { scroller, body } = createMarkdownPreview();
    body.classList.add("compact");
    scroller.addEventListener("click", (event) => {
      const link = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
      if (link) {
        event.preventDefault();
        const href = link.getAttribute("href") ?? "";
        const file = issueFileLink(href, provider, issueUrl);
        const path = file === undefined ? undefined : resolveLink("", file);
        const target = issueLink(href, issueUrl);
        if (path !== undefined) {
          openFile(path);
        } else if (target !== undefined) {
          void window.tet.shell.openUrl(target);
        }
      }
    });
    host.current?.replaceChildren(scroller);
    renderHtmlInto(body, issueTextHtml(text, provider, issueUrl), loadImage).catch((error: unknown) =>
      console.warn("[TET] An issue's text failed to render:", error),
    );
  }, [text, provider, issueUrl, loadImage, openFile]);
  return <div ref={host} className="issue-text" />;
}

/** The box text for the tracker is typed into, with a preview of it as the tracker will show it: with
 *  `upload`, a file picked, pasted or dropped is uploaded at once, its Markdown following what stands
 *  there. */
function TextBox({
  label,
  value,
  onChange,
  disabled,
  upload,
  accept,
  rendering,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  upload: IssueActions["upload"] | undefined;
  /** What the picker offers, an `accept`; absent offers any file. */
  accept: string | undefined;
  /** What the preview renders the text with. */
  rendering: Omit<IssueTextProps, "text">;
}) {
  const textMenu = useTextContextMenu(onChange);
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const attach = async (files: File[]): Promise<void> => {
    setUploading(true);
    let next = value;
    for (const file of files) {
      const markdown = await upload?.(file);
      if (markdown !== undefined) {
        next = `${next}${next === "" || next.endsWith("\n") ? "" : "\n"}${markdown}\n`;
      }
    }
    onChange(next);
    setUploading(false);
  };
  const busy = disabled || uploading;
  return (
    <div
      onDragOver={(event) => {
        if (upload && !busy && event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        const files = [...event.dataTransfer.files];
        if (upload && !busy && files.length > 0) {
          event.preventDefault();
          void attach(files);
        }
      }}
    >
      <div className="issue-box-tabs" role="tablist">
        {[
          { name: "Write", active: !previewing },
          { name: "Preview", active: previewing },
        ].map(({ name, active }) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={active}
            className={`issue-box-tab${active ? " active" : ""}`}
            disabled={busy}
            onClick={() => setPreviewing(name === "Preview")}
          >
            {name}
          </button>
        ))}
      </div>
      {previewing ? (
        <div className="issue-box-preview">
          {value.trim() === "" ? <div className="issue-empty">Nothing to preview</div> : <IssueText {...rendering} text={value} />}
        </div>
      ) : (
        <textarea
          aria-label={label}
          placeholder="Use Markdown to format your text"
          value={value}
          disabled={busy}
          onChange={(event) => onChange(event.target.value)}
          onContextMenu={textMenu.onContextMenu}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (upload && files.length > 0) {
              event.preventDefault();
              void attach(files);
            }
          }}
        />
      )}
      {textMenu.menu}
      {upload && (
        <>
          <input
            ref={picker}
            type="file"
            accept={accept}
            multiple
            hidden
            onChange={(event) => {
              void attach([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <button type="button" className="issue-attach" disabled={busy} onClick={() => picker.current?.click()}>
            <PaperclipIcon className="tree-icon" />
            Paste, drop, or click to add files
          </button>
        </>
      )}
    </div>
  );
}

function CommentBox({
  open,
  actions,
  upload,
  accept,
  rendering,
}: {
  open: boolean;
  actions: IssueActions;
  upload: IssueActions["upload"] | undefined;
  accept: string | undefined;
  rendering: Omit<IssueTextProps, "text">;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const typed = text.trim() !== "";
  const submit = async (): Promise<void> => {
    setBusy(true);
    if (await actions.comment(text)) {
      setText("");
    }
    setBusy(false);
  };
  /** What was typed goes up first: refused, the state stays as well. */
  const changeState = async (): Promise<void> => {
    setBusy(true);
    if (!typed || (await actions.comment(text))) {
      setText("");
      actions.update({ state: open ? "closed" : "open" });
    }
    setBusy(false);
  };
  return (
    <div className="issue-comment">
      <div className="issue-card">
        <div className="issue-card-header">
          <span className="issue-card-author">Add a comment</span>
        </div>
        <div className="issue-card-edit">
          <TextBox
            label="Add a comment"
            value={text}
            onChange={setText}
            disabled={busy}
            upload={upload}
            accept={accept}
            rendering={rendering}
          />
        </div>
      </div>
      <div className="issue-line">
        <button type="button" className="button secondary" disabled={busy} onClick={() => void changeState()}>
          {open ? "Close Issue" : "Reopen Issue"}
          {typed && " with Comment"}
        </button>
        <button type="button" className="button" disabled={busy || !typed} onClick={() => void submit()}>
          Comment
        </button>
      </div>
    </div>
  );
}

interface IssueCardProps extends IssueTextProps {
  author: string;
  avatar: string | undefined;
  /** The issue's own text, whose title says it was opened; a comment's names the author and time alone. */
  opened?: boolean;
  at: string;
  upload: IssueActions["upload"] | undefined;
  accept: string | undefined;
  /** Offered where it can be changed; false keeps the box open. */
  onEdit?: (text: string) => Promise<boolean>;
  onDelete?: () => void;
}

function IssueCard({ author, avatar, opened, at, upload, accept, onEdit, onDelete, ...shown }: IssueCardProps) {
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    setBusy(true);
    if (draft !== undefined && (await onEdit?.(draft))) {
      setDraft(undefined);
    }
    setBusy(false);
  };
  return (
    <div className="issue-card">
      <div className="issue-card-header">
        <Person login={author} avatar={avatar} />
        <span className="issue-card-title">
          <span className="issue-card-author">{author}</span> {opened && "opened "}
          {agoOf(at)}
        </span>
        {onEdit && (
          <IconButton title="Edit" onClick={() => setDraft(shown.text)}>
            <PencilIcon />
          </IconButton>
        )}
        {onDelete && (
          <IconButton title="Delete..." onClick={onDelete}>
            <TrashIcon />
          </IconButton>
        )}
      </div>
      {draft !== undefined ? (
        <div className="issue-comment issue-card-edit">
          <TextBox
            label="Text"
            value={draft}
            onChange={setDraft}
            disabled={busy}
            upload={upload}
            accept={accept}
            rendering={{
              provider: shown.provider,
              issueUrl: shown.issueUrl,
              loadImage: shown.loadImage,
              openFile: shown.openFile,
            }}
          />
          <div className="issue-line">
            <button type="button" className="button secondary" disabled={busy} onClick={() => setDraft(undefined)}>
              Cancel
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => void save()}>
              Save
            </button>
          </div>
        </div>
      ) : shown.text === "" ? (
        <div className="issue-empty">No description provided.</div>
      ) : (
        <IssueText {...shown} />
      )}
    </div>
  );
}

/** Names as a sentence lists them, each set apart by `show`. */
function listed(names: string[], show: (name: string) => React.ReactNode): React.ReactNode {
  return names.map((name, index) => (
    <Fragment key={name}>
      {index > 0 && (index === names.length - 1 ? " and " : ", ")}
      {show(name)}
    </Fragment>
  ));
}

function login(name: string): React.ReactNode {
  return <span className="issue-event-name">{name}</span>;
}

function label(name: string): React.ReactNode {
  return <span className="issue-label">{name}</span>;
}

function assigneesMessage(actor: string, assigned: string[], unassigned: string[]): React.ReactNode {
  const added = assigned.length === 1 && assigned[0] === actor ? "self-assigned this" : <>assigned {listed(assigned, login)}</>;
  const taken =
    unassigned.length === 1 && unassigned[0] === actor ? "removed their assignment" : <>unassigned {listed(unassigned, login)}</>;
  if (assigned.length > 0 && unassigned.length > 0) {
    return (
      <>
        {added} and {taken}
      </>
    );
  }
  return assigned.length > 0 ? added : taken;
}

function labelsMessage(added: string[], removed: string[]): React.ReactNode {
  const noun = added.length + removed.length > 1 ? "labels" : "label";
  if (added.length > 0 && removed.length > 0) {
    return (
      <>
        added {listed(added, label)} and removed {listed(removed, label)} {noun}
      </>
    );
  }
  const names = added.length > 0 ? added : removed;
  return (
    <>
      {added.length > 0 ? "added" : "removed"} {names.length === 1 && "the "}
      {listed(names, label)} {noun}
    </>
  );
}

function eventMessage(event: ThreadEvent): React.ReactNode {
  switch (event.kind) {
    case "closed":
      return "closed this issue";
    case "reopened":
      return "reopened this issue";
    case "assignees":
      return assigneesMessage(event.actor, event.assigned, event.unassigned);
    case "labels":
      return labelsMessage(event.added, event.removed);
    case "milestoned":
      return <>added this to the {login(event.milestone)} milestone</>;
    case "demilestoned":
      return <>removed this from the {login(event.milestone)} milestone</>;
    case "renamed":
      return (
        <>
          changed the title <del className="issue-event-old">{event.from}</del> <ins className="issue-event-new">{event.to}</ins>
        </>
      );
    case "linked":
      return (
        <>
          linked <ActionLink onClick={() => void window.tet.shell.openUrl(event.url)}>#{event.number}</ActionLink> {event.title}
        </>
      );
    case "text":
      return event.text;
  }
}

/** A line of the thread saying what happened, as the plugin's timeline draws one. */
function IssueEventLine({ event, avatar }: { event: ThreadEvent; avatar: string | undefined }) {
  return (
    <div className="issue-event">
      <Person login={event.actor} avatar={avatar} />
      <span className="issue-event-message">
        {login(event.actor)} {eventMessage(event)} <span className="issue-event-time">{agoOf(event.createdAt)}</span>
      </span>
    </div>
  );
}

/** The question renaming an issue asks, wherever it is offered. */
export function askIssueTitle(current: string, submit: (title: string) => Promise<string | undefined>): Promise<void> {
  return askName({ title: "Rename issue", label: "Title", current, confirmLabel: "Rename", submit });
}

/** The question deleting an issue asks, wherever it is offered. */
export function confirmDeleteIssue(number: number): Promise<boolean> {
  return confirmed({
    title: "Delete issue",
    message: `Delete issue #${number}?`,
    detail: "It is deleted on the tracker for good, with its comments.",
    confirmLabel: "Delete",
  });
}

/** The agents an issue can be opened in, wherever that is offered: those a prompt can start. */
export function issueAgentEntries(agents: readonly AgentInfo[], open: (agentId: AgentId) => void): ContextMenuEntry[] {
  return agents.filter((agent) => agent.takesPrompt).map((agent) => agentEntry(agent, () => open(agent.id)));
}

/** The tab's bar, as a file's: what can be done to the issue, its state, then what names it. */
function IssueBar({ issue, actions }: { issue: IssueDetail; actions: IssueActions }) {
  const agents = useAgents();
  // As a pane's new-tab menu: a button's padding off it, and beside the bar, whose stacking it slides
  // out from behind.
  const agentMenu = useAnchoredMenu((rect) => ({ x: rect.left - 6, y: rect.bottom + BAR_MENU_DROP }), true);
  const agentEntries = (): ContextMenuEntry[] => {
    const offered = issueAgentEntries(agents, actions.openInAgent);
    return offered.length > 0 ? offered : [{ label: "No agent installed" }];
  };
  return (
    <>
      <div className="editor-bar">
        <div className="editor-bar-actions">
          <IconButton title="Refresh" onClick={actions.refresh}>
            <SyncIcon />
          </IconButton>
          <IconButton title="Copy Link" onClick={() => void navigator.clipboard.writeText(issue.url)}>
            <LinkIcon />
          </IconButton>
          <IconButton title="Open in Browser" onClick={() => void window.tet.shell.openUrl(issue.url)}>
            <RemoteIcon />
          </IconButton>
          <button type="button" className="icon-button" title="Open in Agent" onMouseDown={agentMenu.open}>
            <SquareSparklesIcon />
          </button>
          <IconButton title="Rename Issue..." onClick={() => void askIssueTitle(issue.title, actions.rename)}>
            <PencilIcon />
          </IconButton>
          <IconButton
            title="Delete Issue..."
            onClick={() => void confirmDeleteIssue(issue.number).then((answer) => (answer ? actions.deleteIssue() : undefined))}
          >
            <TrashIcon />
          </IconButton>
        </div>
        <div className="editor-bar-actions">
          <span className={issue.open ? "issue-state open" : "issue-state"}>{issue.open ? "Open" : "Closed"}</span>
        </div>
        <div className="issue-bar-name">
          <span className="editor-path issue-bar-title" title={issue.title}>
            {issue.title}
          </span>
          <span className="count-badge issue-bar-number">#{issue.number}</span>
        </div>
      </div>
      {agentMenu.render(agentEntries, "new-tab-menu")}
    </>
  );
}

function SideSection({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="issue-side-section">
      <div className="issue-side-title">
        <span>{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

/** A section of what the issue has of a list, and the list to change it from: every pick is set at
 *  once. What it has stays offered, whether or not the tracker still lists it. `several` for more
 *  than one at a time. */
function PickSection({
  title,
  picked,
  several,
  load,
  onChange,
  children,
}: {
  title: string;
  picked: string[];
  several: boolean;
  load: () => Promise<string[] | undefined>;
  onChange: (picked: string[]) => void;
  children: React.ReactNode;
}) {
  const [options, setOptions] = useState<string[]>();
  return (
    <SideSection
      title={title}
      action={
        <PickMenu
          className="icon-button"
          title={`Change ${title}`}
          options={options && [...new Set([...options, ...picked])]}
          isPicked={(option) => picked.includes(option)}
          onPick={(option) => {
            const rest = picked.filter((entry) => entry !== option);
            onChange(picked.includes(option) ? rest : several ? [...picked, option] : [option]);
          }}
          several={several}
          onOpen={() => {
            if (options === undefined) {
              void load().then(setOptions);
            }
          }}
        >
          <GearIcon />
        </PickMenu>
      }
    >
      {children}
    </SideSection>
  );
}

/**
 * An issue's tab: a bar as a file's, with its actions, title and state, then, as VS Code's GitHub Pull
 * Requests and Issues draws them, the description and comments with a box for one more, and beside
 * them who and what it is assigned. Only the viewer's own comments offer to change: the tracker's REST says nothing of who
 * else may, and a description it refuses says so in a notice, a title in the dialog that asked.
 */
export function IssueView({ issue, actions }: { issue: IssueDetail; actions: IssueActions }) {
  const { loadImage, openFile } = actions;
  const upload = issue.uploads ? actions.upload : undefined;
  const accept = issue.uploads?.extensions?.map((extension) => `.${extension}`).join(",");
  // One request for both lists, however many are opened; a failed one is asked again.
  const options = useRef<ReturnType<IssueActions["options"]>>(undefined);
  const loadOptions = async (): ReturnType<IssueActions["options"]> => {
    options.current ??= actions.options();
    const loaded = await options.current;
    if (!loaded) {
      options.current = undefined;
    }
    return loaded;
  };
  const milestones = useRef<IssueMilestone[]>([]);
  const { viewer } = issue;
  return (
    <>
      <IssueBar issue={issue} actions={actions} />
      <div className="issue-view">
        <div className="issue-columns">
          <div className="issue-thread">
            <IssueCard
              author={issue.author}
              avatar={issue.avatars[issue.author]}
              opened
              at={issue.createdAt}
              text={issue.body}
              provider={issue.provider}
              issueUrl={issue.url}
              loadImage={loadImage}
              openFile={openFile}
              upload={upload}
              accept={accept}
              onEdit={(body) => {
                actions.update({ body });
                return Promise.resolve(true);
              }}
            />
            {issueThread(issue.notes, issue.events).map((entry, index) => {
              if ("event" in entry) {
                return <IssueEventLine key={`event${index}`} event={entry.event} avatar={issue.avatars[entry.event.actor]} />;
              }
              const { note } = entry;
              return (
                <IssueCard
                  key={note.id}
                  author={note.author}
                  avatar={issue.avatars[note.author]}
                  at={note.createdAt}
                  text={note.body}
                  provider={issue.provider}
                  issueUrl={issue.url}
                  loadImage={loadImage}
                  openFile={openFile}
                  upload={upload}
                  accept={accept}
                  onEdit={note.author === viewer ? (body) => actions.editComment(note.id, body) : undefined}
                  onDelete={
                    note.author === viewer
                      ? () =>
                          void confirmed({
                            title: "Delete comment",
                            message: "Delete this comment?",
                            detail: "It is deleted on the tracker for good.",
                            confirmLabel: "Delete",
                          }).then((answer) => (answer ? actions.deleteComment(note.id) : undefined))
                      : undefined
                  }
                />
              );
            })}
            <CommentBox
              open={issue.open}
              actions={actions}
              upload={upload}
              accept={accept}
              rendering={{ provider: issue.provider, issueUrl: issue.url, loadImage, openFile }}
            />
          </div>
          <div className="issue-side">
            <PickSection
              title="Assignees"
              picked={issue.assignees}
              several
              load={() => loadOptions().then((loaded) => loaded?.people)}
              onChange={(assignees) => actions.update({ assignees })}
            >
              {issue.assignees.length === 0 && <span className="issue-none">None</span>}
              {issue.assignees.map((login) => (
                <div key={login} className="issue-side-person">
                  <Person login={login} avatar={issue.avatars[login]} />
                  <span>{login}</span>
                </div>
              ))}
              {viewer !== undefined && !issue.assignees.includes(viewer) && (
                <ActionLink onClick={() => actions.update({ assignees: [...issue.assignees, viewer] })}>Assign yourself</ActionLink>
              )}
            </PickSection>
            <PickSection
              title="Labels"
              picked={issue.labels}
              several
              load={() => loadOptions().then((loaded) => loaded?.labels)}
              onChange={(labels) => actions.update({ labels })}
            >
              {issue.labels.length === 0 && <span className="issue-none">None</span>}
              <div className="issue-labels">
                {issue.labels.map((label) => (
                  <span key={label} className="issue-label">
                    {label}
                  </span>
                ))}
              </div>
            </PickSection>
            <PickSection
              title="Milestone"
              picked={issue.milestone === undefined ? [] : [issue.milestone]}
              several={false}
              load={async () => {
                milestones.current = (await actions.milestones()) ?? [];
                return milestones.current.map((milestone) => milestone.title);
              }}
              onChange={([title]) =>
                actions.update({ milestone: milestones.current.find((milestone) => milestone.title === title) ?? null })
              }
            >
              <span className={issue.milestone === undefined ? "issue-none" : undefined}>{issue.milestone ?? "None"}</span>
            </PickSection>
          </div>
        </div>
      </div>
    </>
  );
}
