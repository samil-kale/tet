import { memo, useEffect, useRef, useState } from "react";
import { formatEnv, isSameCommand, parseEnv } from "../../shared/command";
import type { ProjectCommand } from "../../shared/types";
import { ContextMenu, type ContextMenuEntry } from "../ui/ContextMenu";
import { confirm, prompt, type PromptAnswer } from "../ui/Dialog";
import { reorder, useDragReorder } from "./drag-reorder";
import { PlayIcon, PlusIcon, SparkleIcon } from "../ui/icons";
import { ProgressBar } from "../ui/ProgressBar";

/**
 * A type of our own, for the same reason the project list has one: a row dragged across a
 * terminal must not end up pasted into it, and this list is no target for anything else.
 */
const DRAG_TYPE = "application/x-tet-command";

/** The optional fields of the dialog, the same in the one that adds and the one that edits. */
const EXTRA_FIELDS = [
  { label: "Name (optional)", placeholder: "what the row calls it, e.g. Start the backend" },
  { label: "Folder (optional)", placeholder: "relative to the project, e.g. web" },
  { label: "Environment (optional)", placeholder: "PROFILE=DEVELOPMENT PORT=8080" }
];

const COMMAND_DETAIL = "Saved to tet.json in the project. The command is started without a shell.";

/**
 * What the dialog was answered with as an entry, carrying only what was filled in: a folder or
 * an environment written into every one would put the long form in tet.json for commands
 * that have nothing to say beyond themselves.
 *
 * `shell` is carried over from the command being edited rather than asked for — the dialog does
 * not offer it, and editing a command must not quietly change how it is started.
 */
function toCommand(answer: PromptAnswer, edited?: ProjectCommand): ProjectCommand {
  const [name, cwd, env] = answer.extras;
  const command: ProjectCommand = { command: answer.value };
  if (name) {
    command.name = name;
  }
  if (cwd) {
    command.cwd = cwd;
  }
  const variables = parseEnv(env);
  if (variables) {
    command.env = variables;
  }
  if (edited?.shell) {
    command.shell = true;
  }
  return command;
}

/** The whole command as a tooltip: the line, where it runs, and what it runs with. */
function describe(command: ProjectCommand): string {
  const lines = [command.command];
  if (command.cwd) {
    lines.push(`in ${command.cwd}`);
  }
  for (const [name, value] of Object.entries(command.env ?? {})) {
    lines.push(`${name}=${value}`);
  }
  if (command.shell) {
    lines.push("through a shell, so only on this platform");
  }
  return lines.join("\n");
}

interface CommandListProps {
  /** Whose commands these are; null when no project is open. */
  projectId: string | null;
  /** Dragged on the sash above the list, which is why it isn't a style of its own. */
  height: number;
  /** The tab a started command opened, so the app can bring it to the front — in the pane the
      command last ran in, which is why the command line travels along. */
  onOpenTab: (projectId: string, tabId: string, command?: string) => void;
}

/**
 * A project's saved shell commands, under the project list. They come from a tet.json in
 * the repository's own root, so they belong to the project rather than to this machine, and
 * they change with the project the sidebar has selected.
 *
 * Running one opens a terminal tab and hands it over, so this list keeps no state about what
 * is running.
 */
export const CommandList = memo(function CommandList({ projectId, height, onOpenTab }: CommandListProps) {
  const [commands, setCommands] = useState<ProjectCommand[]>([]);
  /** The projects the wand is out for; this view outlives a project switch. */
  const [suggestingIn, setSuggestingIn] = useState<string[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; command: ProjectCommand } | null>(null);
  /** Which project is on screen, readable from a callback that started before a switch. */
  const shown = useRef(projectId);
  /** The list as it stands now, for callbacks that were made before the last change to it. */
  const latest = useRef<ProjectCommand[]>([]);

  const { rowProps, listProps, rowClasses } = useDragReorder({
    dragType: DRAG_TYPE,
    count: commands.length,
    // The row's position, not its command: the same command can be in the list twice, once
    // per folder it runs in, and the rows hold no state of their own that reordering could
    // carry to the wrong one.
    payloadOf: String,
    indexOf: Number,
    onMove: (from, to) => save(reorder(commands, from, to))
  });

  const suggesting = projectId !== null && suggestingIn.includes(projectId);

  useEffect(() => {
    shown.current = projectId;
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      applyCommands([]);
      return;
    }
    let cancelled = false;
    void window.tet.commands.list(projectId).then((saved) => {
      if (cancelled) {
        return;
      }
      applyCommands(saved ?? []);
    });
    // The file is the record, and it changes without this list: an editor, an agent in one of
    // the tabs, a checkout. Read again on every change, our own writes included — those come
    // back as what is already shown. No lookup for a file gone missing here: the unasked agent
    // run is for a project seen for the first time, not for a delete.
    const unsubscribe = window.tet.commands.onChanged((payload) => {
      if (payload.projectId !== projectId) {
        return;
      }
      void window.tet.commands.list(projectId).then((saved) => {
        if (!cancelled) {
          applyCommands(saved ?? []);
        }
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId]);

  /**
   * Every change to the list goes through here, and `latest` is what it is computed from
   * rather than the `commands` a callback closed over: a dialog is awaited, and the wand can
   * finish while one stands open — adding a command off the pre-dialog list would then write
   * the found ones straight back out of the file.
   */
  const applyCommands = (next: ProjectCommand[]): void => {
    latest.current = next;
    setCommands(next);
  };

  /** The list is written whole; the file is the record, this is only what is on screen. */
  const save = (next: ProjectCommand[]): void => {
    if (!projectId) {
      return;
    }
    applyCommands(next);
    void window.tet.commands.save(projectId, next);
  };

  const askAdd = async (): Promise<void> => {
    const answer = await prompt({
      title: "New command",
      label: "Command",
      detail: COMMAND_DETAIL,
      value: "",
      confirmLabel: "Save",
      extras: EXTRA_FIELDS,
      valueIndex: 1,
      wide: true
    });
    if (answer === null) {
      return;
    }
    const command = toCommand(answer);
    const current = latest.current;
    if (!current.some((entry) => isSameCommand(entry, command))) {
      save([...current, command]);
    }
  };

  /**
   * Where the command sits in the latest list. By identity when it can be — a re-read of the
   * file (250ms after every save of our own, or an agent touching tet.json) replaces every
   * object while a dialog stands, and the row is then found by what it says instead. -1 once
   * it is gone altogether: the wand can replace the list wholesale.
   */
  const indexOf = (command: ProjectCommand): number => {
    const exact = latest.current.indexOf(command);
    return exact !== -1 ? exact : latest.current.findIndex((entry) => isSameCommand(entry, command));
  };

  /** The same dialog as `askAdd`, opened with what the command already says. */
  const askEdit = async (command: ProjectCommand): Promise<void> => {
    const answer = await prompt({
      title: "Edit command",
      label: "Command",
      detail: COMMAND_DETAIL,
      value: command.command,
      confirmLabel: "Save",
      extras: [
        { ...EXTRA_FIELDS[0], value: command.name },
        { ...EXTRA_FIELDS[1], value: command.cwd },
        { ...EXTRA_FIELDS[2], value: formatEnv(command.env) }
      ],
      valueIndex: 1,
      wide: true
    });
    if (answer === null) {
      return;
    }
    const current = latest.current;
    const index = indexOf(command);
    // Gone from the list while the dialog stood: what was edited is a row that no longer
    // exists, and writing it back would put it there again.
    if (index === -1) {
      return;
    }
    save(current.map((entry, position) => (position === index ? toCommand(answer, command) : entry)));
  };

  const askRemove = async (command: ProjectCommand): Promise<void> => {
    const answer = await confirm({
      title: "Delete command",
      message: `Delete "${command.command}"?`,
      detail: "It is removed from the project's tet.json.",
      confirmLabel: "Delete"
    });
    if (answer.confirmed) {
      const index = indexOf(command);
      if (index !== -1) {
        save(latest.current.filter((_entry, position) => position !== index));
      }
    }
  };

  /** Confirms before the wand runs, since what it finds replaces the list without review. */
  const askSuggest = async (project: string): Promise<void> => {
    const answer = await confirm({
      title: "Find commands automatically",
      message: "An agent will look through the project and suggest commands to run.",
      detail: "The suggestions are added to the list without review — they don't always work correctly.",
      confirmLabel: "Find commands"
    });
    if (answer.confirmed) {
      void suggest(project);
    }
  };

  /**
   * The wand. The agent reads the project and names what it can run; the whole list comes
   * back, so this does not have to re-read the file. It can take minutes, long enough for the
   * user to have moved on — the result then belongs to a project this view no longer shows,
   * and only to the file it was already written to. Putting it on screen anyway would show one
   * project's commands under another's name, and the next drag would save them there.
   */
  const suggest = async (project: string): Promise<void> => {
    if (suggestingIn.includes(project)) {
      return;
    }
    setSuggestingIn((current) => [...current, project]);
    try {
      const found = await window.tet.commands.suggest(project);
      if (shown.current === project) {
        applyCommands(found);
      }
    } finally {
      setSuggestingIn((current) => current.filter((entry) => entry !== project));
    }
  };

  /** Opens the tab the command runs in and switches to it; the tab is where it is watched. */
  const run = (command: ProjectCommand): void => {
    if (!projectId) {
      return;
    }
    const project = projectId;
    void window.tet.commands.run(project, command).then((tab) => {
      if (tab) {
        onOpenTab(project, tab.tabId, tab.command);
      }
    });
  };

  const menuEntries = (command: ProjectCommand): ContextMenuEntry[] => [
    { label: "Run", run: () => run(command) },
    { label: "Edit...", run: () => void askEdit(command) },
    { label: "Delete...", run: () => void askRemove(command) }
  ];

  return (
    <div className="section" style={{ height }}>
      <div className="section-header">
        <span>
          COMMANDS <span className="count-badge">({commands.length})</span>
        </span>
        <span className="section-header-actions">
          <button
            className="icon-button"
            title={suggesting ? "Looking for commands..." : "Automatically find commands"}
            disabled={!projectId || suggesting}
            onClick={() => projectId && void askSuggest(projectId)}
          >
            <SparkleIcon />
          </button>
          <button className="icon-button" title="New command" disabled={!projectId} onClick={() => void askAdd()}>
            <PlusIcon />
          </button>
        </span>
        {/* This pane's own bar — an agent reading the repository for its commands. */}
        {suggesting && <ProgressBar />}
      </div>
      <div className="command-list" {...listProps}>
        {commands.map((command, index) => (
          <div
            // The position, not the command — see the hook's payload above.
            key={index}
            className={["command-item", ...rowClasses(index)].join(" ")}
            title={describe(command)}
            {...rowProps(index)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, command });
            }}
          >
            {/* Its name where it has one: a long invocation is not what the row is for, and the
                line itself is a tooltip away. */}
            <span className="command-main">
              <span className="command-label">{command.name ?? command.command}</span>
              {/* What it runs with, where anything is set and the row is still showing the command
                  line itself — the line alone would otherwise look like it runs with a plain
                  environment. A named row says nothing of the kind and stays a label; its tooltip
                  has all of it. Never the folder either: a variable changes what the command does,
                  while the folder only says where it stands. */}
              {!command.name && formatEnv(command.env) && (
                <span className="command-extra">({formatEnv(command.env)})</span>
              )}
            </span>
            <button className="icon-button" title={`Run ${command.command} in a new tab`} onClick={() => run(command)}>
              <PlayIcon />
            </button>
          </div>
        ))}
        {projectId && commands.length === 0 && <div className="placeholder">No commands yet.</div>}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.command)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
});
