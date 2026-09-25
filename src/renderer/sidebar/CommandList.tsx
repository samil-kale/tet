import { memo, useEffect, useRef, useState } from "react";
import { formatEnv, isSameCommand, parseEnv } from "../../shared/command";
import { COMMAND_COLORS, type CommandColor, type ProjectCommand } from "../../shared/types";
import { useContextMenu, type ContextMenuEntry } from "../ui/ContextMenu";
import { notifying } from "../git/run-action";
import { confirm, filled, prompt, refusal, type PromptOptions } from "../ui/Dialog";
import { ColorField, TextField } from "../ui/Field";
import { reorder, useDragReorder } from "./drag-reorder";
import { PlayIcon, PlusIcon } from "../ui/icons";
import { Section } from "../ui/Section";

/** Our own type, so a row dragged over a terminal is not pasted into it. */
const DRAG_TYPE = "application/x-tet-command";

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

/** What the add and edit dialogs hold, as typed; the color "" for none. */
interface CommandAnswer {
  command: string;
  name: string;
  cwd: string;
  env: string;
  color: string;
}

/** The add and edit dialogs' fields: the command is the one required. */
const renderCommandFields: PromptOptions<CommandAnswer>["render"] = ({ value, onChange, error, busy, field }) => (
  <>
    <TextField
      label="Name (optional)"
      value={value.name}
      placeholder="what the row calls it, e.g. Start the backend"
      onChange={(name) => onChange({ ...value, name })}
    />
    <TextField
      label="Command"
      value={value.command}
      onChange={(command) => onChange({ ...value, command })}
      disabled={busy}
      ref={field}
      error={error}
    />
    <TextField
      label="Folder (optional)"
      value={value.cwd}
      placeholder="relative to the project, e.g. web"
      onChange={(cwd) => onChange({ ...value, cwd })}
    />
    <TextField
      label="Environment (optional)"
      value={value.env}
      placeholder="PROFILE=DEVELOPMENT PORT=8080"
      onChange={(env) => onChange({ ...value, env })}
    />
    <ColorField
      label="Color (optional)"
      choices={COLOR_CHOICES}
      value={value.color}
      onChange={(color) => onChange({ ...value, color })}
    />
  </>
);

/** The dialog's answer as an entry with only what was filled in, so a bare command stays a plain
 *  string in tet.json. `shell` carries over from the edited command: editing must not change how
 *  it starts. */
function toCommand(answer: CommandAnswer, edited?: ProjectCommand): ProjectCommand {
  const name = answer.name.trim();
  const cwd = answer.cwd.trim();
  const env = answer.env.trim();
  const command: ProjectCommand = { command: answer.command.trim() };
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
  /** False for a worktree, which runs its main worktree's commands but never changes them
   *  (tet-json.ts's configRoot). */
  editable: boolean;
  /** Brings a started command's tab to front in the pane the command last ran in — hence the
      command line. */
  onOpenTab: (projectId: string, tabId: string, command?: string) => void;
}

/** A project's saved commands, from tet.json in the repository root, so they travel with the
 *  project. Running one opens a terminal tab. One list serves every project: the active one's. */
export const CommandList = memo(function CommandList({ projectId, height, editable, onOpenTab }: CommandListProps) {
  /** Tagged with its project: until the next project's list answers, the previous one is held but
   *  counts as none, so neither Run nor a reorder acts on it in the wrong project. */
  const [held, setHeld] = useState<{ projectId: string; commands: ProjectCommand[] } | undefined>(undefined);
  const commands = held?.projectId === projectId ? held.commands : [];
  const menu = useContextMenu<ProjectCommand>();
  /** The current list, for callbacks created before its last change; tagged like `held`. */
  const latest = useRef<{ projectId: string; commands: ProjectCommand[] } | undefined>(undefined);
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
      return;
    }
    let cancelled = false;
    const load = (): void => {
      void window.tet.commands.list(projectId).then((saved) => {
        if (!cancelled) {
          applyCommands(projectId, saved);
        }
      });
    };
    load();
    // The file is the record and changes outside this list, so every change is re-read.
    const unsubscribe = window.tet.commands.onChanged((payload) => {
      if (payload.projectId === projectId) {
        load();
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId]);

  /** Every change goes through here; callers compute from `latest`, not a closed-over `commands`,
   *  since the file can change while a dialog is open. */
  const applyCommands = (project: string, next: ProjectCommand[]): void => {
    const tagged = { projectId: project, commands: next };
    latest.current = tagged;
    setHeld(tagged);
  };

  /** The latest list if it is the shown project's, else none. */
  const latestCommands = (): ProjectCommand[] =>
    latest.current?.projectId === shownProject.current ? latest.current.commands : [];

  /** Writes the list whole, handing back what refused it — for the questions that stay up to show
   *  it at their field (`prompt`'s `submit`). */
  const saveAsked = async (next: ProjectCommand[]): Promise<string | undefined> => {
    // A dialog answered after the project changed built `next` from the other project's list, and
    // one answered before this project's list arrived from none.
    if (!projectId || projectId !== shownProject.current || latest.current?.projectId !== projectId) {
      return undefined;
    }
    applyCommands(projectId, next);
    return refusal(await window.tet.commands.save(projectId, next), "Could not save the commands");
  };

  /** The same for a change with no question up: a reorder, a remove. */
  const save = notifying(saveAsked);

  const askAdd = async (): Promise<void> => {
    await prompt({
      title: "New command",
      detail: COMMAND_DETAIL,
      value: { command: "", name: "", cwd: "", env: "", color: "" },
      confirmLabel: "Save",
      ready: ({ command }) => filled(command),
      render: renderCommandFields,
      submit: async (answer) => {
        const command = toCommand(answer);
        const current = latestCommands();
        // Already saved word for word: nothing to add, and nothing to say about it.
        return current.some((entry) => isSameCommand(entry, command)) ? undefined : saveAsked([...current, command]);
      }
    });
  };

  /** The command's index in the latest list: by identity, else by content, since a re-read while a
   *  dialog is open replaces every object. */
  const indexOf = (command: ProjectCommand): number => {
    const current = latestCommands();
    const exact = current.indexOf(command);
    return exact !== -1 ? exact : current.findIndex((entry) => isSameCommand(entry, command));
  };

  /** `askAdd`'s dialog, prefilled. */
  const askEdit = async (command: ProjectCommand): Promise<void> => {
    await prompt({
      title: "Edit command",
      detail: COMMAND_DETAIL,
      value: {
        command: command.command,
        name: command.name ?? "",
        cwd: command.cwd ?? "",
        env: formatEnv(command.env),
        color: command.color ?? ""
      },
      confirmLabel: "Save",
      ready: ({ command: typed }) => filled(typed),
      render: renderCommandFields,
      submit: async (answer) => {
        const current = latestCommands();
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
        save(latestCommands().filter((_entry, position) => position !== index));
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
    ...(editable
      ? [
          { label: "Edit...", run: () => void askEdit(command) },
          { label: "Delete...", run: () => void askRemove(command) }
        ]
      : [])
  ];

  return (
    <Section
      title="COMMANDS"
      count={commands.length}
      height={height}
      actions={
        editable && (
          <button className="icon-button" title="New command" disabled={!projectId} onClick={() => void askAdd()}>
            <PlusIcon />
          </button>
        )
      }
    >
      <div className="command-list" {...(editable ? listProps : {})}>
        {commands.map((command, index) => (
          <div
            // The position, as in the hook's payload above.
            key={index}
            className={["command-item", ...rowClasses(index)].join(" ")}
            title={describe(command)}
            {...(editable ? rowProps(index) : {})}
            onContextMenu={(event) => menu.open(event, command)}
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
        {projectId && held?.projectId === projectId && commands.length === 0 &&<div className="placeholder">No commands yet.</div>}
      </div>

      {menu.render(menuEntries)}
    </Section>
  );
});
