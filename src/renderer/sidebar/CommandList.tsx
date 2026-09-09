import { memo, useEffect, useRef, useState } from "react";
import { formatEnv, isSameCommand, parseEnv } from "../../shared/command";
import type { ProjectCommand } from "../../shared/types";
import { ContextMenu, type ContextMenuEntry } from "../ui/ContextMenu";
import { confirm, prompt, type PromptAnswer } from "../ui/Dialog";
import { reorder, useDragReorder } from "./drag-reorder";
import { PlayIcon, PlusIcon } from "../ui/icons";

/** A type of our own: a row dragged across a terminal must not end up pasted into it. */
const DRAG_TYPE = "application/x-tet-command";

/** The optional fields of the dialog, the same in the one that adds and the one that edits. */
const EXTRA_FIELDS = [
  { label: "Name (optional)", placeholder: "what the row calls it, e.g. Start the backend" },
  { label: "Folder (optional)", placeholder: "relative to the project, e.g. web" },
  { label: "Environment (optional)", placeholder: "PROFILE=DEVELOPMENT PORT=8080" }
];

const COMMAND_DETAIL = "Saved to tet.json in the project. The command is started without a shell.";

/** What the dialog was answered with as an entry, carrying only what was filled in, so a command
 *  with nothing to say beyond itself stays a plain string in tet.json. `shell` is carried over
 *  from the command being edited: editing must not quietly change how it is started. */
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
  /** Dragged on the sash above the list. */
  height: number;
  /** The tab a started command opened, brought to the front in the pane the command last ran in
      — hence the command line travelling along. */
  onOpenTab: (projectId: string, tabId: string, command?: string) => void;
}

/** A project's saved shell commands, from a tet.json in the repository's own root, so they
 *  belong to the project rather than to this machine. Running one opens a terminal tab. */
export const CommandList = memo(function CommandList({ projectId, height, onOpenTab }: CommandListProps) {
  const [commands, setCommands] = useState<ProjectCommand[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; command: ProjectCommand } | null>(null);
  /** The list as it stands now, for callbacks that were made before the last change to it. */
  const latest = useRef<ProjectCommand[]>([]);

  const { rowProps, listProps, rowClasses } = useDragReorder({
    dragType: DRAG_TYPE,
    count: commands.length,
    // The row's position, not its command: the same command can be in the list twice, once per
    // folder it runs in, and the rows hold no state of their own.
    payloadOf: String,
    indexOf: Number,
    onMove: (from, to) => save(reorder(commands, from, to))
  });

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
      applyCommands(saved);
    });
    // The file is the record and changes without this list, so every change is read again.
    const unsubscribe = window.tet.commands.onChanged((payload) => {
      if (payload.projectId !== projectId) {
        return;
      }
      void window.tet.commands.list(projectId).then((saved) => {
        if (!cancelled) {
          applyCommands(saved);
        }
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId]);

  /** Every change goes through here, computed from `latest` rather than the `commands` a callback
   *  closed over: a dialog is awaited, and the file can change while one stands open. */
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

  /** Where the command sits in the latest list. By identity when it can be: a re-read of the file
   *  replaces every object while a dialog stands, so the row is then found by what it says. */
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
    // Gone from the list while the dialog stood: writing it back would put it there again.
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
          <button className="icon-button" title="New command" disabled={!projectId} onClick={() => void askAdd()}>
            <PlusIcon />
          </button>
        </span>
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
            {/* Its name where it has one; the line itself is a tooltip away. */}
            <span className="command-main">
              <span className="command-label">{command.name ?? command.command}</span>
              {/* `env` is shown on unnamed rows only — it changes what the command does; the
                  folder does not. */}
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
