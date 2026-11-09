import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import type { IssueChange, IssueDetail, IssueField, IssueFieldValue, ProviderId } from "../../shared/types/providers";
import { ActionLink } from "../ui/ActionLink";
import type { AgentId, AgentInfo } from "../../shared/types/agents";
import { agentEntry } from "../ui/agent-icons";
import { BAR_MENU_DROP, useAnchoredMenu, type ContextMenuEntry } from "../ui/ContextMenu";
import { askName, confirmed, filled, prompt, singleField } from "../ui/Dialog";
import { Checkbox, FieldRow, TextAreaField, TextField } from "../ui/Field";
import { IconButton } from "../ui/IconButton";
import {
  BoldIcon,
  CodeIcon,
  GearIcon,
  HeadingIcon,
  ItalicIcon,
  LinkIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  QuoteIcon,
  RemoteIcon,
  SquareSparklesIcon,
  TrashIcon,
  type IconProps,
} from "../ui/icons";
import { MenuButton } from "../ui/MenuButton";
import { PickMenu } from "../ui/PickMenu";
import { SwitchTabs } from "../ui/SwitchTabs";
import { useTextContextMenu } from "../ui/use-text-context-menu";
import { useAgents } from "../ui/use-agents";
import { sectionsOf, type AskedField } from "./issue-fields";
import { issueThread, type ThreadEvent } from "./issue-thread";
import { issueFileLink, issueLink, issueTextHtml } from "./issue-text";
import { createMarkdownPreview, renderHtmlInto, resolveLink } from "./markdown";
import { markdownEdit, type MarkdownFormat } from "./markdown-format";

const DAY_MS = 86_400_000;

/** The widest a list opened from the side column's icons gets, in px: longer names end in an ellipsis. */
const SIDE_MENU_MAX_WIDTH = 300;

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
  comment: (body: string, internal: boolean) => Promise<boolean>;
  editComment: (id: string, body: string) => Promise<boolean>;
  deleteComment: (id: string) => Promise<void>;
  deleteIssue: () => Promise<void>;
  update: (change: IssueChange) => void;
  /** The title changed; what the tracker refused, for the dialog that asked (`askName`). */
  rename: (title: string) => Promise<string | undefined>;
  /** What a pick field can be set to; undefined, with a notice, when the tracker cannot say. */
  fieldOptions: (fieldId: string) => Promise<string[] | undefined>;
  setField: (fieldId: string, value: IssueFieldValue) => void;
  /** A field set; what the tracker refused, for the dialog that asked (`askFieldValue`). */
  editField: (fieldId: string, value: IssueFieldValue) => Promise<string | undefined>;
  /** The Markdown that shows the file, once it is up. */
  upload: (file: File) => Promise<string | undefined>;
  openInAgent: (agentId: AgentId) => void;
}

/** What an issue's text is rendered with. */
export interface TextRendering {
  provider: ProviderId;
  /** What a relative link leads from. */
  issueUrl: string;
  loadImage: LoadImage;
  openFile: IssueActions["openFile"];
}

/** What a box writing an issue's text takes beside its value, the same for every box of the issue. */
export interface TextWriting {
  /** What the preview renders the text with. */
  rendering: TextRendering;
  /** Where the tracker takes a file for the text. */
  upload: IssueActions["upload"] | undefined;
  /** What the picker offers, an `accept`; absent offers any file. */
  accept: string | undefined;
}

/** Text written on the tracker, rendered in a shadow root of its own as the Markdown preview's is
 *  (`issueTextHtml`), before the card's first paint. A link to a file of the repository opens it; the
 *  rest go to main, which opens only web and mail ones. `text` is the Markdown as written. */
function IssueText({ text, provider, issueUrl, loadImage, openFile }: TextRendering & { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const { scroller, body } = createMarkdownPreview();
    body.classList.add("compact");
    scroller.addEventListener("click", (event) => {
      const link = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
      if (link) {
        event.preventDefault();
        const href = link.getAttribute("href") ?? "";
        const file = issueFileLink(href, issueUrl);
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

const BOX_TABS = [
  { id: "write", label: "Write" },
  { id: "preview", label: "Preview" },
] as const;

/** The buttons above a text box, each a format of its selection. */
const BOX_FORMATS: { format: MarkdownFormat; title: string; Icon: ComponentType<IconProps> }[] = [
  { format: "heading", title: "Heading", Icon: HeadingIcon },
  { format: "bold", title: "Bold", Icon: BoldIcon },
  { format: "italic", title: "Italic", Icon: ItalicIcon },
  { format: "quote", title: "Quote", Icon: QuoteIcon },
  { format: "code", title: "Code", Icon: CodeIcon },
  { format: "link", title: "Link", Icon: LinkIcon },
  { format: "bullets", title: "Bulleted List", Icon: ListIcon },
  { format: "numbers", title: "Numbered List", Icon: ListOrderedIcon },
  { format: "tasks", title: "Task List", Icon: ListChecksIcon },
];

/** The box text for the tracker is typed into, with a preview of it as the tracker will show it: with
 *  `upload`, a file picked, pasted or dropped is uploaded at once, its Markdown following what stands
 *  there. */
export function TextBox({
  label,
  value,
  onChange,
  disabled,
  writing: { rendering, upload, accept },
  height,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  writing: TextWriting;
  /** The box's and its preview's least height, in px; absent takes `--text-box-height`. */
  height?: number;
}) {
  const textMenu = useTextContextMenu(onChange);
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  // What the textarea was dragged to, kept across the switch to the preview, which unmounts it.
  const [dragged, setDragged] = useState<number>();
  const switchTo = (preview: boolean): void => {
    if (preview && field.current) {
      setDragged(field.current.offsetHeight);
    }
    setPreviewing(preview);
  };
  const format = (kind: MarkdownFormat): void => {
    const area = field.current;
    if (!area) {
      return;
    }
    const edit = markdownEdit(kind, area.value, area.selectionStart, area.selectionEnd);
    area.focus();
    area.setSelectionRange(edit.from, edit.to);
    // Typed in, as the textarea's own undo takes it back; the change reaches `onChange` as typing's
    // does. Nothing else edits a textarea into its undo history.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    document.execCommand("insertText", false, edit.insert);
    area.setSelectionRange(...edit.select);
  };
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
      style={height === undefined ? undefined : ({ "--text-box-height": `${height}px` } as React.CSSProperties)}
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
      <div className="issue-box-tabs">
        <SwitchTabs tabs={BOX_TABS} active={previewing ? "preview" : "write"} onSelect={(id) => switchTo(id === "preview")} locked={busy} />
        {!previewing && (
          <div className="toolbar issue-box-tools">
            {BOX_FORMATS.map(({ format: kind, title, Icon }) => (
              <IconButton
                key={kind}
                title={title}
                disabled={busy}
                // The focus stays in the textarea, whose selection is what the format reads.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => format(kind)}
              >
                <Icon />
              </IconButton>
            ))}
          </div>
        )}
      </div>
      {previewing ? (
        <div className="issue-box-preview" style={{ minHeight: dragged }}>
          {value.trim() === "" ? <div className="issue-empty">Nothing to preview</div> : <IssueText {...rendering} text={value} />}
        </div>
      ) : (
        <textarea
          ref={field}
          aria-label={label}
          placeholder="Use Markdown to format your text"
          style={{ height: dragged }}
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
            <PaperclipIcon className="line-icon" />
            Paste, drop, or click to add files
          </button>
        </>
      )}
    </div>
  );
}

interface CommentBoxProps {
  open: boolean;
  /** Offered where the tracker has internal comments. */
  internalNotes: boolean;
  actions: IssueActions;
  writing: TextWriting;
}

function CommentBox({ open, internalNotes, actions, writing }: CommentBoxProps) {
  const [text, setText] = useState("");
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const typed = text.trim() !== "";
  const noun = internal ? "Internal Note" : "Comment";
  const reset = (): void => {
    setText("");
    setInternal(false);
  };
  const submit = async (): Promise<void> => {
    setBusy(true);
    if (await actions.comment(text, internal)) {
      reset();
    }
    setBusy(false);
  };
  /** What was typed goes up first: refused, the state stays as well. */
  const changeState = async (): Promise<void> => {
    setBusy(true);
    if (!typed || (await actions.comment(text, internal))) {
      reset();
      actions.update({ state: open ? "closed" : "open" });
    }
    setBusy(false);
  };
  return (
    <div className="issue-comment">
      <div className="issue-card">
        <div className="issue-card-edit">
          <TextBox label="Add a comment" value={text} onChange={setText} disabled={busy} writing={writing} />
        </div>
      </div>
      <div className="issue-line">
        {internalNotes && <Checkbox label="Make this an internal note" checked={internal} onChange={setInternal} disabled={busy} />}
        <button type="button" className="button secondary" disabled={busy} onClick={() => void changeState()}>
          {open ? "Close Issue" : "Reopen Issue"}
          {typed && ` with ${noun}`}
        </button>
        <button type="button" className="button" disabled={busy || !typed} onClick={() => void submit()}>
          {internal ? "Add Internal Note" : "Comment"}
        </button>
      </div>
    </div>
  );
}

interface IssueCardProps {
  author: string;
  avatar: string | undefined;
  /** The issue's own text, whose title says it was opened; a comment's names the author and time alone. */
  opened?: boolean;
  at: string;
  /** The Markdown as written. */
  text: string;
  writing: TextWriting;
  /** A comment the project's members alone see: marked as such. */
  internal?: boolean;
  /** Offered where it can be changed; false keeps the box open. */
  onEdit?: (text: string) => Promise<boolean>;
  onDelete?: () => void;
}

function IssueCard({ author, avatar, opened, at, text, writing, internal, onEdit, onDelete }: IssueCardProps) {
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
        {internal && (
          <span className="issue-label" title="Visible to project members only">
            Internal note
          </span>
        )}
        {onEdit && (
          <IconButton title="Edit" onClick={() => setDraft(text)}>
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
          <TextBox label="Text" value={draft} onChange={setDraft} disabled={busy} writing={writing} />
          <div className="issue-line">
            <button type="button" className="button secondary" disabled={busy} onClick={() => setDraft(undefined)}>
              Cancel
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => void save()}>
              Save
            </button>
          </div>
        </div>
      ) : text === "" ? (
        <div className="issue-empty">No description provided.</div>
      ) : (
        <IssueText {...writing.rendering} text={text} />
      )}
    </div>
  );
}

/** Items as a sentence lists them, each set apart by `show`, the last joined by `joiner`. */
function listed<T = string>(items: T[], show: (item: T) => React.ReactNode, joiner = "and"): React.ReactNode {
  return items.map((item, index) => (
    <Fragment key={index}>
      {index > 0 && (index === items.length - 1 ? ` ${joiner} ` : ", ")}
      {show(item)}
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
function IssueEventLine({ event }: { event: ThreadEvent }) {
  return (
    <div className="issue-event">
      <span className="issue-event-dot" />
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

/** The question deleting a comment or a time entry asks: it is deleted on the tracker for good. */
function confirmDeleteOnTracker(what: string): Promise<boolean> {
  return confirmed({
    title: `Delete ${what}`,
    message: `Delete this ${what}?`,
    detail: "It is deleted on the tracker for good.",
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
      <div className="editor-bar issue-bar">
        <div className="toolbar editor-bar-actions">
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
        <div className="toolbar editor-bar-actions issue-state">{issue.open ? "Open" : "Closed"}</div>
        <div className="toolbar editor-bar-actions issue-bar-number">#{issue.number}</div>
        <span className="editor-bar-title" title={issue.title}>
          {issue.title}
        </span>
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
  editable,
  load,
  onChange,
  children,
}: {
  title: string;
  picked: string[];
  several: boolean;
  editable: boolean;
  load: () => Promise<string[] | undefined>;
  onChange: (picked: string[]) => void;
  children: React.ReactNode;
}) {
  const [options, setOptions] = useState<string[]>();
  // One request however many times the menu is opened; a failed one is asked again.
  const asked = useRef<Promise<void> | undefined>(undefined);
  return (
    <SideSection
      title={title}
      action={
        editable && (
          <PickMenu
            className="icon-button"
            title={`Change ${title}`}
            maxWidth={SIDE_MENU_MAX_WIDTH}
            options={options && [...new Set([...options, ...picked])]}
            isPicked={(option) => picked.includes(option)}
            onPick={(option) => {
              const rest = picked.filter((entry) => entry !== option);
              onChange(picked.includes(option) ? rest : several ? [...picked, option] : [option]);
            }}
            several={several}
            onOpen={() => {
              if (options === undefined) {
                asked.current ??= load().then((loaded) => {
                  asked.current = undefined;
                  setOptions(loaded);
                });
              }
            }}
          >
            <GearIcon />
          </PickMenu>
        )
      }
    >
      {children}
    </SideSection>
  );
}

/** A field that is typed rather than picked. */
type TypedField = Exclude<AskedField, { kind: "timelog" }>;

/** What a typed field's dialog tells of what to type. */
const TYPING_HINTS: Record<TypedField["kind"], string> = {
  text: "Some text",
  number: "A number",
  date: "A date",
  duration: "For example 3h 30m",
};

/** The question a text, a number, a date or a duration is changed in; an empty answer takes the value
 *  off, and `edit` answers what the tracker refused. */
async function askFieldValue(field: TypedField, edit: (value: IssueFieldValue) => Promise<string | undefined>): Promise<void> {
  await prompt({
    title: `Change ${field.name.toLowerCase()}`,
    detail: `${TYPING_HINTS[field.kind]}. Empty takes it off.`,
    confirmLabel: "Save",
    value: field.value === undefined ? "" : String(field.value),
    ready: () => true,
    render: singleField(field.name, undefined, field.kind === "date" ? "date" : undefined),
    submit: (typed) => {
      const text = typed.trim();
      return edit(text === "" ? null : field.kind === "number" ? Number(text) : text);
    },
  });
}

/** What the time entry's question holds while it is typed. */
interface TimeEntryDraft {
  timeSpent: string;
  spentAt: string;
  summary: string;
}

/** The question a booking of time is made in; `edit` answers what the tracker refused. */
async function askTimeEntry(edit: (value: IssueFieldValue) => Promise<string | undefined>): Promise<void> {
  await prompt<TimeEntryDraft>({
    title: "Add time entry",
    detail: "Track time spent on this issue.",
    confirmLabel: "Save",
    value: { timeSpent: "", spentAt: "", summary: "" },
    ready: (draft) => filled(draft.timeSpent),
    render: ({ value, onChange, error, busy, field: input }) => (
      <>
        <FieldRow>
          <TextField
            label="Time spent"
            placeholder="1h 30m"
            value={value.timeSpent}
            onChange={(timeSpent) => onChange({ ...value, timeSpent })}
            disabled={busy}
            ref={input}
            error={error}
          />
          <TextField
            label="Spent at (optional)"
            type="date"
            value={value.spentAt}
            onChange={(spentAt) => onChange({ ...value, spentAt })}
            disabled={busy}
          />
        </FieldRow>
        <TextAreaField
          label="Summary (optional)"
          value={value.summary}
          onChange={(summary) => onChange({ ...value, summary })}
          disabled={busy}
        />
      </>
    ),
    submit: ({ timeSpent, spentAt, summary }) =>
      edit({ timeSpent: timeSpent.trim(), spentAt: spentAt || undefined, summary: summary.trim() || undefined }),
  });
}

/** Asks for the field's change; `actions.editField` answers what the tracker refused. */
function askField(field: AskedField, actions: IssueActions): Promise<void> {
  const edit = (value: IssueFieldValue) => actions.editField(field.id, value);
  return field.kind === "timelog" ? askTimeEntry(edit) : askFieldValue(field, edit);
}

/** What a group's menu calls the change of one of its fields. */
function changeLabel(field: AskedField): string {
  return field.kind === "timelog" ? "Add time entry" : `Set ${field.name.toLowerCase()}`;
}

/** The bookings of time an issue has, each with its time, day, who made it and what it was for; one the
 *  viewer's rights allow is taken back after a question. */
function TimeLogs({
  field,
  avatars,
  actions,
}: {
  field: Extract<IssueField, { kind: "timelog" }>;
  avatars: IssueDetail["avatars"];
  actions: IssueActions;
}) {
  return field.entries.map((entry) => (
    <div key={entry.id} className="issue-time-log">
      <div className="issue-time-log-line">
        <span>{entry.timeSpent}</span>
        {entry.spentAt && <span className="issue-side-name">{entry.spentAt}</span>}
        {entry.removable && (
          <IconButton
            title="Delete..."
            onClick={() =>
              void confirmDeleteOnTracker("time entry").then((answer) =>
                answer ? actions.setField(field.id, { remove: entry.id }) : undefined,
              )
            }
          >
            <TrashIcon />
          </IconButton>
        )}
      </div>
      <div className="issue-side-person">
        <Person login={entry.author} avatar={avatars[entry.author]} />
        <span className="issue-side-name">{entry.author}</span>
      </div>
      {entry.summary && <div className="issue-side-name">{entry.summary}</div>}
    </div>
  ));
}

/** A typed field's value in the side column, "None" where it has none. */
function FieldValue({ value }: { value: string | number | undefined }) {
  return <span className={value === undefined ? "issue-none" : undefined}>{value ?? "None"}</span>;
}

/** The fields of one group as a section: their values or, where none has one, a sentence offering to
 *  add them; its one button opens a menu of what can be set. */
function GroupSection({
  title,
  fields,
  avatars,
  actions,
}: {
  title: string;
  fields: AskedField[];
  avatars: IssueDetail["avatars"];
  actions: IssueActions;
}) {
  const editable = fields.filter((field) => field.editable);
  const entries: ContextMenuEntry[] = editable.map((field) => ({
    label: changeLabel(field),
    run: () => void askField(field, actions),
  }));
  return (
    <SideSection
      title={title}
      action={
        editable.length > 0 && (
          <MenuButton
            className="icon-button"
            title={`Change ${title}`}
            entries={entries}
            menuClassName="field-menu"
            maxWidth={SIDE_MENU_MAX_WIDTH}
          >
            <PlusIcon />
          </MenuButton>
        )
      }
    >
      {fields.every((field) => field.value === undefined) ? (
        <span className="issue-none">
          {editable.length === 0 ? (
            "None"
          ) : (
            <>
              Add{" "}
              {listed(
                editable,
                (field) => (
                  <ActionLink onClick={() => void askField(field, actions)}>{field.name.toLowerCase()}</ActionLink>
                ),
                "or",
              )}
              .
            </>
          )}
        </span>
      ) : (
        fields.map((field) => (
          <div key={field.id} className="issue-side-row">
            <span className="issue-side-name">{field.name}</span>
            <FieldValue value={field.value} />
          </div>
        ))
      )}
      {fields.map((field) => field.kind === "timelog" && <TimeLogs key={field.id} field={field} avatars={avatars} actions={actions} />)}
    </SideSection>
  );
}

/** What a field's pick holds, as its values are drawn: as labels, people too, or plain text. */
function PickValue({
  field,
  viewer,
  actions,
}: {
  field: Extract<IssueField, { kind: "pick" }>;
  viewer: string | undefined;
  actions: IssueActions;
}) {
  return (
    <>
      {field.value.length === 0 && <span className="issue-none">None</span>}
      {field.shown !== "text" && (
        <div className="issue-labels">
          {field.value.map((label) => (
            <span key={label} className="issue-label">
              {label}
            </span>
          ))}
        </div>
      )}
      {field.shown === "text" && field.value.length > 0 && <span>{field.value.join(", ")}</span>}
      {field.shown === "people" && field.editable && viewer !== undefined && !field.value.includes(viewer) && (
        <ActionLink onClick={() => actions.setField(field.id, field.several ? [...field.value, viewer] : [viewer])}>
          Assign yourself
        </ActionLink>
      )}
    </>
  );
}

/** One field of the issue in the side column, drawn by its kind; where it can be changed, its section
 *  offers how. */
function FieldSection({ field, issue, actions }: { field: IssueField; issue: IssueDetail; actions: IssueActions }) {
  switch (field.kind) {
    case "pick":
      return (
        <PickSection
          title={field.name}
          picked={field.value}
          several={field.several}
          editable={field.editable}
          load={() => actions.fieldOptions(field.id)}
          onChange={(value) => actions.setField(field.id, value)}
        >
          <PickValue field={field} viewer={issue.viewer} actions={actions} />
        </PickSection>
      );
    case "flag":
      return (
        <div className="issue-side-section">
          <Checkbox
            label={field.name}
            checked={field.value}
            disabled={!field.editable}
            onChange={(checked) => actions.setField(field.id, checked)}
          />
        </div>
      );
    case "timelog":
      return (
        <SideSection
          title={field.name}
          action={
            field.editable && (
              <IconButton title="Add time entry" onClick={() => void askField(field, actions)}>
                <PlusIcon />
              </IconButton>
            )
          }
        >
          <FieldValue value={field.value} />
          <TimeLogs field={field} avatars={issue.avatars} actions={actions} />
        </SideSection>
      );
    case "text":
    case "number":
    case "date":
    case "duration":
      return (
        <SideSection
          title={field.name}
          action={
            field.editable && (
              <IconButton title={`Change ${field.name}`} onClick={() => void askField(field, actions)}>
                <GearIcon />
              </IconButton>
            )
          }
        >
          <FieldValue value={field.value} />
        </SideSection>
      );
  }
}

/**
 * An issue's tab: a bar as a file's, with its actions, title and state, then, as VS Code's GitHub Pull
 * Requests and Issues draws them, the description and comments with a box for one more, and beside
 * them the fields the tracker keeps of it. Only the viewer's own comments offer to change: what is
 * read of the tracker says nothing of who else may, and a description it refuses says so in a notice,
 * a title in the dialog that asked.
 */
export function IssueView({ issue, actions }: { issue: IssueDetail; actions: IssueActions }) {
  const writing: TextWriting = {
    rendering: { provider: issue.provider, issueUrl: issue.url, loadImage: actions.loadImage, openFile: actions.openFile },
    upload: issue.uploads ? actions.upload : undefined,
    accept: issue.uploads?.extensions?.map((extension) => `.${extension}`).join(","),
  };
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
              writing={writing}
              onEdit={(body) => {
                actions.update({ body });
                return Promise.resolve(true);
              }}
            />
            {issueThread(issue.notes, issue.events).map((entry, index) => {
              if ("event" in entry) {
                return <IssueEventLine key={`event${index}`} event={entry.event} />;
              }
              const { note } = entry;
              return (
                <IssueCard
                  key={note.id}
                  author={note.author}
                  avatar={issue.avatars[note.author]}
                  at={note.createdAt}
                  text={note.body}
                  writing={writing}
                  internal={note.internal}
                  onEdit={note.author === viewer ? (body) => actions.editComment(note.id, body) : undefined}
                  onDelete={
                    note.author === viewer
                      ? () => void confirmDeleteOnTracker("comment").then((answer) => (answer ? actions.deleteComment(note.id) : undefined))
                      : undefined
                  }
                />
              );
            })}
            <CommentBox open={issue.open} internalNotes={issue.internalNotes === true} actions={actions} writing={writing} />
          </div>
          <div className="issue-side">
            {sectionsOf(issue.fields).map((section) =>
              "group" in section ? (
                <GroupSection key={section.group} title={section.group} fields={section.fields} avatars={issue.avatars} actions={actions} />
              ) : (
                <FieldSection key={section.field.id} field={section.field} issue={issue} actions={actions} />
              ),
            )}
          </div>
        </div>
      </div>
    </>
  );
}
