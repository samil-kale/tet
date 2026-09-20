import { memo, useEffect, useRef, useState } from "react";
import { formatEnv, isSameCommand, parseEnv } from "../../shared/command";
import { COMMAND_COLORS, type CommandColor, type ProjectCommand } from "../../shared/types";
import { ContextMenu, type ContextMenuEntry } from "../ui/ContextMenu";
import { notifying, refusal } from "../git/run-action";
import { confirm, prompt, type PromptAnswer } from "../ui/Dialog";
import { reorder, useDragReorder } from "./drag-reorder";
import { PlayIcon, PlusIcon } from "../ui/icons";

/** Our own type, so a row dragged over a terminal is not pasted into it. */
const DRAG_TYPE = "application/x-tet-command";

/** The optional fields, shared by the add and edit dialogs. */
const EXTRA_FIELDS = [
  { label: "Name (optional)", placeholder: "what the row calls it, e.g. Start the backend" },
  { label: "Folder (optional)", placeholder: "relative to the project, e.g. web" },
  { label: "Environment (optional)", placeholder: "PROFILE=DEVELOPMENT PORT=8080" }
];

const COMMAND_DETAIL = "Saved to tet.json in the project. The command is started without a shell.";

function capitalized(color: CommandColor): string {
  return color[0].toUpperCase() + color.slice(1);
}

/** The terminal's own color for a name, so the rows recolor with the theme. */
function colorVariable(color: CommandColor): string {
  return `var(--vscode-terminal-ansiBright${capitalized(color)})`;
}

/** The swatches the dialog offers, the bright six in the theme's own colors. */
const COLOR_CHOICES = COMMAND_COLORS.map((color) => ({
  value: color,
  color: colorVariable(color),
  title: capitalized(color)
}));

const COLOR_FIELD = { label: "Color (optional)", choices: COLOR_CHOICES };

/** The dialog's answer as an entry with only what was filled in, so a bare command stays a plain
 *  string in tet.json. `shell` carries over from the edited command: editing must not change how
 *  it starts. */
function toCommand(answer: PromptAnswer, edited?: ProjectCommand): ProjectCommand {
  const [name, cwd, env] = answer.extras;
  const command: ProjectCommand = { command: answer.value };
  if (name) {
    command.name = name;
  }
  const color = COMMAND_COLORS.find((candidate) => candidate === answer.color);
  if (color) {
    command.color = color;
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

/** The tooltip: the line, its folder, its env. */
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
  /** null when no project is open. */
  projectId: string | null;
  /** Set by the sash above the list. */
  height: number;
  /** Brings a started command's tab to front in the pane the command last ran in — hence the
      command line. */
  onOpenTab: (projectId: string, tabId: string, command?: string) => void;
}

/** A project's saved commands, from tet.json in the repository root, so they travel with the
 *  project. Running one opens a terminal tab. One list serves every project: the active one's. */
export const CommandList = memo(function CommandList({ projectId, height, onOpenTab }: CommandListProps) {
  const [commands, setCommands] = useState<ProjectCommand[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; command: ProjectCommand } | null>(null);
  /** The current list, for callbacks created before its last change. */
  const latest = useRef<ProjectCommand[]>([]);
  /** The project currently shown, for the same callbacks. */
  const shownProject = useRef(projectId);

  const { rowProps, listProps, rowClasses } = useDragReorder({
    dragType: DRAG_TYPE,
    count: commands.length,
    // The position, not the command: a command can appear twice (once per folder), and rows hold
    // no state.
    payloadOf: String,
    indexOf: Number,
    onMove: (from, to) => save(reorder(commands, from, to))
  });

  useEffect(() => {
    shownProject.current = projectId;
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
    // The file is the record and changes outside this list, so every change is re-read.
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

  /** Every change goes through here; callers compute from `latest`, not a closed-over `commands`,
   *  since the file can change while a dialog is open. */
  const applyCommands = (next: ProjectCommand[]): void => {
    latest.current = next;
    setCommands(next);
  };

  /** Writes the list whole, handing back what refused it — for the questions that stay up to show
   *  it at their field (`prompt`'s `submit`). */
  const saveAsked = async (next: ProjectCommand[]): Promise<string | undefined> => {
    // A dialog answered after the project changed built `next` from the other project's list.
    if (!projectId || projectId !== shownProject.current) {
      return undefined;
    }
    applyCommands(next);
    return refusal(await window.tet.commands.save(projectId, next), "Could not save the commands");
  };

  /** The same for a change with no question up: a reorder, a remove. */
  const save = notifying(saveAsked);

  const askAdd = async (): Promise<void> => {
    await prompt({
      title: "New command",
      label: "Command",
      detail: COMMAND_DETAIL,
      value: "",
      confirmLabel: "Save",
      extras: EXTRA_FIELDS,
      valueIndex: 1,
      colors: COLOR_FIELD,
      submit: async (answer) => {
        const command = toCommand(answer);
        const current = latest.current;
        // Already saved word for word: nothing to add, and nothing to say about it.
        return current.some((entry) => isSameCommand(entry, command)) ? undefined : saveAsked([...current, command]);
      }
    });
  };

  /** The command's index in the latest list: by identity, else by content, since a re-read while a
   *  dialog is open replaces every object. */
  const indexOf = (command: ProjectCommand): number => {
    const exact = latest.current.indexOf(command);
    return exact !== -1 ? exact : latest.current.findIndex((entry) => isSameCommand(entry, command));
  };

  /** `askAdd`'s dialog, prefilled. */
  const askEdit = async (command: ProjectCommand): Promise<void> => {
    await prompt({
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
      colors: { ...COLOR_FIELD, value: command.color },
      submit: async (answer) => {
        const current = latest.current;
        const index = indexOf(command);
        // Removed while the dialog was open: writing it back would resurrect it.
        return index === -1
          ? undefined
          : saveAsked(current.map((entry, position) => (position === index ? toCommand(answer, command) : entry)));
      }
    });
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

  /** Opens the command's tab and switches to it. */
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
            // The position, as in the hook's payload above.
            key={index}
            className={["command-item", ...rowClasses(index)].join(" ")}
            title={describe(command)}
            {...rowProps(index)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, command });
            }}
          >
            {/* Its name if any; the line is in the tooltip. */}
            <span className="command-main">
              <span
                className="command-label"
                style={command.color ? { color: colorVariable(command.color) } : undefined}
              >
                {command.name ?? command.command}
              </span>
              {/* `env` on unnamed rows only: it changes what the command does, the folder does not. */}
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
