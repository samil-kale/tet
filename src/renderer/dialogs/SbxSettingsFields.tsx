import { Fragment, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type {
  SbxAccess,
  SbxSkillsSettings,
  SbxSkillsEntry,
  SbxSkillsKind,
  SbxSkillsSource,
  SbxLocalEdits,
  SbxLocalSave,
  SbxPath,
  SbxPort,
  SbxProblems,
  SbxProjectSettings,
  SbxRegisteredMcp,
  SbxStoredLocal,
} from "../../shared/types/sbx";
import {
  problemOf,
  sbxMcpRefusal,
  sbxNeedsRestart,
  sbxPortKey,
  sbxPortRefusal,
  sbxVariableRefusal,
  setupLines,
} from "../../shared/sbx-rules";
import { CodeField } from "../editor/CodeField";
import { PLATFORM } from "../platform";
import { ActionLink } from "../ui/ActionLink";
import {
  atLeastOne,
  EditRow,
  firstMark,
  patched,
  RowInput,
  RowMark,
  RowSection,
  SecretInput,
  typedRows,
  withId,
  without,
  type Row,
} from "../ui/RowSection";
import { BLANK_MCP, isEmptyMcpRow, MCP_NEEDS_SIGN_IN, needsSignIn, SbxMcpSection, type McpRow } from "./SbxMcp";
import { Dropdown } from "../ui/Dropdown";
import { Checkbox, FieldGroup, FieldRow, PathInput } from "../ui/Field";
import { AgentIcon } from "../ui/agent-icons";

const ACCESS_OPTIONS: { value: SbxAccess; label: string }[] = [
  { value: "ro", label: "Read" },
  { value: "rw", label: "Read+Write" },
];

/** Where the skills come from: `SbxSkillsSettings.skillsFolder` absent, or set. */
type SkillsSource = "agents" | "folder";

const SKILLS_SOURCE_OPTIONS: { value: SkillsSource; label: string }[] = [
  { value: "agents", label: "Each agent's own" },
  { value: "folder", label: "A folder" },
];

/** One row per `SbxSkillsKind`, in display order. Labels only; the per-agent host paths are
 *  `AgentSandbox.skills`. */
const SKILLS_LABELS: { kind: SbxSkillsKind; label: string }[] = [
  { kind: "skills", label: "Skills" },
  { kind: "instructions", label: "CLAUDE.md / AGENTS.md" },
];

/** How long typing pauses before the rows are checked again (useSbxProblems). */
const CHECK_DELAY_MS = 500;

export interface FieldsState {
  /** This machine's (`sbx:stored`); what each kind mounts is `AgentSandbox.skills`.
   *  `skillsFolder` is "" while "A folder" is chosen and none picked yet. */
  skills: SbxSkillsSettings;
  ports: Row<SbxPort>[];
  paths: Row<SbxPath>[];
  hosts: Row<{ host: string }>[];
  /** `value` only what was typed since opening — a stored one never reaches the renderer; `from`
   *  the name a row was opened under (SbxLocalEdits). */
  variables: Row<{ env: string; value: string; from?: string }>[];
  mcp: McpRow[];
  /** The setup script as typed. */
  setup: string;
}

/** A typed section's row as "+ Add" makes it, and as one stands in where the section has none
 *  (`atLeastOne`); the paths come from a picker and have none. */
const BLANK_PORT = { host: "", container: "" };
const BLANK_HOST = { host: "" };
const BLANK_VARIABLE = { env: "", value: "" };

/** `sbx:get-settings`'s and `sbx:stored`'s answers as rows. Only the user's paths: TET's directories
 *  and each agent's session directory are always mounted (sbx-mounts.ts's fixedMountSpecs,
 *  sessionMountSpecs), not shown. */
export function fromSettings(settings: SbxProjectSettings, stored: SbxStoredLocal): FieldsState {
  return {
    skills: stored.skills,
    ports: atLeastOne(settings.ports.map(withId), BLANK_PORT),
    paths: settings.paths.map(withId),
    hosts: atLeastOne(
      settings.hosts.map((host) => withId({ host })),
      BLANK_HOST,
    ),
    variables: atLeastOne(
      settings.variables.map((variable) => withId({ env: variable.env, value: "", from: variable.env })),
      BLANK_VARIABLE,
    ),
    mcp: atLeastOne(
      settings.mcp.map((server) => withId({ name: server.name, url: server.url })),
      BLANK_MCP,
    ),
    setup: settings.setup.join("\n"),
  };
}

/** Why Save refuses a port row, or `undefined`: two empty sides are dropped instead. */
function portRefusal(row: SbxPort): string | undefined {
  return row.host.trim() === "" && row.container.trim() === "" ? undefined : sbxPortRefusal(row);
}

/** A row's name, as Save keeps it, for another row's rules. */
function named(row: { env: string }): { env: string } {
  return { env: row.env.trim() };
}

/** Why Save refuses an MCP row (sbxMcpRefusal), or `undefined`: an empty one is dropped. */
function mcpRefusal(row: McpRow, rows: McpRow[]): string | undefined {
  if (isEmptyMcpRow(row)) {
    return undefined;
  }
  return row.name.trim() === ""
    ? "Needs a name"
    : sbxMcpRefusal(
        { name: row.name, url: row.url },
        rows.filter((other) => other.id !== row.id && !isEmptyMcpRow(other)).map((other) => ({ name: other.name, url: other.url })),
      );
}

/** An MCP row's mark, or `undefined`, likewise; `failure` is what sbx said on refusing its sign-in,
 *  which the row alone holds. The one source of the row's mark and its tab's. */
function mcpMark(
  row: McpRow,
  rows: McpRow[],
  problems: SbxProblems,
  registered: SbxRegisteredMcp[] | undefined | null,
  failure?: string,
): string | undefined {
  return (
    mcpRefusal(row, rows) ??
    problemOf(problems, "mcp", row.name.trim()) ??
    failure ??
    (needsSignIn(registered, row.name.trim()) ? MCP_NEEDS_SIGN_IN : undefined)
  );
}

type VariableRow = FieldsState["variables"][number];

function isEmptyVariableRow(row: VariableRow): boolean {
  return row.env.trim() === "" && row.value === "";
}

/** Why Save refuses a variable row (sbxVariableRefusal), or `undefined`: an empty one is dropped. */
function variableRefusal(row: VariableRow, state: FieldsState): string | undefined {
  return isEmptyVariableRow(row)
    ? undefined
    : sbxVariableRefusal(named(row), state.variables.filter((other) => other.id !== row.id).map(named), PLATFORM.envNamesIgnoreCase);
}

/** Why Save waits, or `undefined`: every port row two ports or empty, every variable row complete
 *  or empty — the rows mark which is not — and skills from a folder with one picked. */
export function saveBlocked(state: FieldsState): string | undefined {
  if (state.ports.some((row) => portRefusal(row) !== undefined)) {
    return "A port on the Ports tab is not a whole number from 1 to 65535";
  }
  if (state.variables.some((row) => variableRefusal(row, state) !== undefined)) {
    return "A variable on the Variables tab needs a name no other variable holds, not PATH or TET_*";
  }
  if (state.mcp.some((row) => mcpRefusal(row, state.mcp) !== undefined)) {
    return "A server on the MCP tab needs a name no other server holds and a URL starting with https:// or http://";
  }
  if (state.skills.skills !== false && state.skills.skillsFolder === "") {
    return "The skills on the Skills tab need a folder";
  }
  return undefined;
}

/** The inverse, for Save: ids dropped, as are empty port, host and variable rows; the
 *  setup script as its lines. */
export function toSettings(state: FieldsState): Omit<SbxProjectSettings, "enabled"> {
  return {
    ports: state.ports
      .map(({ host, container }) => ({ host: host.trim(), container: container.trim() }))
      .filter((port) => port.host && port.container),
    paths: state.paths.map(({ path, access }) => ({ path, access })),
    hosts: state.hosts.map(({ host }) => host.trim()).filter(Boolean),
    variables: state.variables.filter((row) => !isEmptyVariableRow(row)).map((row) => ({ env: row.env.trim() })),
    mcp: state.mcp.filter((row) => !isEmptyMcpRow(row)).map((row) => ({ name: row.name.trim(), url: row.url.trim() })),
    setup: setupLines(state.setup),
  };
}

/** The variables' rows as Save stores them on this machine; a row left without a name holds nothing. */
function toLocalEdits(rows: { env: string; value: string; from?: string }[]): SbxLocalEdits {
  const kept = rows.filter((row) => row.env.trim() !== "");
  return {
    values: Object.fromEntries(kept.filter((row) => row.value !== "").map((row) => [row.env.trim(), row.value])),
    from: Object.fromEntries(kept.flatMap((row) => (row.from === undefined ? [] : [[row.env.trim(), row.from]]))),
  };
}

/** The skills as Save stores it: "A folder" with none picked, while skills are off, is each
 *  agent's own (saveBlocked refuses it while they are on). */
function toSkills(skills: SbxSkillsSettings): SbxSkillsSettings {
  const { skillsFolder, ...kinds } = skills;
  return skillsFolder ? skills : kinds;
}

/** The values typed since opening and each row's name when opened (SbxLocalEdits), and the
 *  skills, for Save. */
export function toLocalSave(state: FieldsState): SbxLocalSave {
  return {
    variables: toLocalEdits(state.variables),
    skills: toSkills(state.skills),
  };
}

/** What `source` mounts for `kind`, for its icon: its own, or for skills the chosen folder. */
function skillsEntries(source: SbxSkillsSource, kind: SbxSkillsKind, skills: SbxSkillsSettings): SbxSkillsEntry[] {
  const folder = skills.skillsFolder;
  if (kind !== "skills" || folder === undefined) {
    return source.own[kind];
  }
  return folder ? source.skillsTargets.map((target) => ({ host: folder, target })) : [];
}

/** Whether the row holds a value on this machine: the one of the name it was opened under. */
function holdsValue(row: { from?: string }, stored: readonly string[]): boolean {
  return row.from !== undefined && stored.includes(row.from);
}

/** Whether the edits since opening reach a running tab only once it restarts (sbxNeedsRestart);
 *  a variable's value is set by `sbx run -e` too. */
export function needsRestart(loaded: SbxProjectSettings, loadedSkills: SbxSkillsSettings, state: FieldsState): boolean {
  return (
    sbxNeedsRestart(loaded, loadedSkills, toSettings(state), toSkills(state.skills)) || state.variables.some((row) => row.value !== "")
  );
}

/** The env names of the rows that hold a value: typed now, or stored under the name the row was
 *  opened under. */
function valueNames(rows: { env: string; value: string; from?: string }[], stored: readonly string[]): string[] {
  return rows.filter((row) => row.env.trim() !== "" && (row.value !== "" || holdsValue(row, stored))).map((row) => row.env.trim());
}

/**
 * What of the rows cannot be applied here (sbx-settings.ts's readProjectSbxProblems), asked as soon
 * as the dialog has its rows (`ready`), whatever tab shows — so a row that cannot be applied is
 * marked from the start, its tab too — then again once typing pauses on a change, since each
 * check is an sbx call. An answer overtaken by an edit is dropped. Save leaves such a row out.
 * `organization` is the governance the dialog's status read, so no check reads it again.
 */
export function useSbxProblems(
  projectId: string,
  state: FieldsState,
  stored: SbxStoredLocal,
  ready: boolean,
  organization: string | undefined,
): SbxProblems {
  const [problems, setProblems] = useState<SbxProblems>({});
  const settings = { enabled: true, ...toSettings(state) };
  const skills = toSkills(state.skills);
  const values = { variables: valueNames(state.variables, stored.variables) };
  const key = JSON.stringify([settings, skills, values, organization]);
  /** The loaded rows go at once; an edit waits (CHECK_DELAY_MS). */
  const opened = useRef(true);
  useEffect(() => {
    if (!ready) {
      return;
    }
    const delay = opened.current ? 0 : CHECK_DELAY_MS;
    opened.current = false;
    let current = true;
    const timer = setTimeout(() => {
      // Where sbx cannot say, the marks stay as they were; Save asks again and stops.
      void window.tet.sbx.problems(projectId, settings, skills, values, { organization }).then(
        (answer) => {
          if (current) {
            setProblems(answer);
          }
        },
        () => undefined,
      );
    }, delay);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // `key` holds everything the check is asked with; the objects themselves are new each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, key]);
  return problems;
}

/** A port row's mark, or `undefined`: why Save refuses it before why it cannot be applied here. */
function portMark(row: FieldsState["ports"][number], problems: SbxProblems): string | undefined {
  return portRefusal(row) ?? problemOf(problems, "ports", sbxPortKey({ host: row.host.trim(), container: row.container.trim() }));
}

/** A variable row's mark, or `undefined`, likewise. */
function variableMark(row: VariableRow, state: FieldsState, problems: SbxProblems): string | undefined {
  return variableRefusal(row, state) ?? problemOf(problems, "variables", row.env.trim());
}

/** Each tab's mark: its first marked row's, repeated on the tab so it shows from any tab. */
export function tabMarks(
  state: FieldsState,
  problems: SbxProblems,
  registered: SbxRegisteredMcp[] | undefined | null,
): Record<keyof FieldsState, string | undefined> {
  return {
    skills: firstMark(SKILLS_LABELS.map(({ kind }) => problemOf(problems, "skills", kind))),
    ports: firstMark(state.ports.map((row) => portMark(row, problems))),
    paths: firstMark(state.paths.map((row) => problemOf(problems, "paths", row.path))),
    hosts: firstMark(state.hosts.map((row) => problemOf(problems, "hosts", row.host.trim()))),
    mcp: firstMark(state.mcp.map((row) => mcpMark(row, state.mcp, problems, registered))),
    variables: firstMark(state.variables.map((row) => variableMark(row, state, problems))),
    // A script as typed has no row to refuse.
    setup: undefined,
  };
}

interface SbxSettingsFieldsProps {
  /** Owned by SbxSettingsDialog, which builds the save request. */
  state: FieldsState;
  setState: Dispatch<SetStateAction<FieldsState>>;
  section: keyof FieldsState;
  /** The env names holding a value on this machine (`sbx:stored`); never a value. */
  stored: SbxStoredLocal;
  /** The agents installed here, for the Skills tab's icons (`sbx:skills-sources`). */
  sources: SbxSkillsSource[];
  /** Asked by the dialog from its opening (useSbxProblems), for the tabs' marks too. */
  problems: SbxProblems;
  /** The MCP tab's browser sign-in, which the dialog holds the bar of. */
  signInMcp: (name: string) => Promise<string | undefined>;
  signingInMcp: boolean;
  /** What sbx has registered, asked by the dialog, and how to ask again. */
  mcpRegistered: SbxRegisteredMcp[] | undefined | null;
  askMcp: () => void;
}

/** One tab of the dialog's fields, shown once sbx is ready (see SbxSettingsDialog). State is
 *  shared across tabs. */
export function SbxSettingsFields({
  state,
  setState,
  section,
  stored,
  sources,
  problems,
  signInMcp,
  signingInMcp,
  mcpRegistered,
  askMcp,
}: SbxSettingsFieldsProps) {
  const update = <K extends keyof FieldsState>(key: K, change: (value: FieldsState[K]) => FieldsState[K]): void =>
    setState((current) => ({ ...current, [key]: change(current[key]) }));

  /** `false` turns a kind off; an `SbxAccess` turns it on with that access. */
  const setSkills = (kind: SbxSkillsKind, value: SbxAccess | false): void => update("skills", (skills) => ({ ...skills, [kind]: value }));
  /** "A folder" shows the picker's row, empty until a folder is picked. */
  const setSkillsFolder = (folder: string | undefined): void =>
    update("skills", (skills) => {
      const next = { ...skills, skillsFolder: folder };
      if (folder === undefined) {
        delete next.skillsFolder;
      }
      return next;
    });
  /** A cancelled pick adds nothing. Folder and file are two buttons: Electron shows both kinds in
   *  one picker only on macOS (see `projects:pick-file`); sbx mounts either the same way. */
  const addPath = async (picked: Promise<string | null>): Promise<void> => {
    const chosen = await picked;
    if (chosen) {
      update("paths", (paths) => [...paths, withId({ path: chosen, access: "rw" })]);
    }
  };

  if (section === "skills") {
    return (
      <FieldGroup label="Bring from this machine">
        <div className="sbx-skills-rows">
          {SKILLS_LABELS.map(({ kind, label }) => {
            const access = state.skills[kind];
            const skills = kind === "skills";
            const folder = skills ? state.skills.skillsFolder : undefined;
            return (
              <Fragment key={kind}>
                {/* Only skills have a source; the other labels take its column too. */}
                <div className={skills ? "sbx-skills-cell" : "sbx-skills-cell sbx-skills-wide"}>
                  <Checkbox label={label} checked={access !== false} onChange={(next) => setSkills(kind, next ? "ro" : false)} />
                  <RowMark title={problemOf(problems, "skills", kind)} />
                </div>
                {skills && (
                  <div className="sbx-skills-cell">
                    {access !== false && (
                      <Dropdown
                        value={folder === undefined ? "agents" : "folder"}
                        options={SKILLS_SOURCE_OPTIONS}
                        onChange={(value) => setSkillsFolder(value === "folder" ? (folder ?? "") : undefined)}
                      />
                    )}
                  </div>
                )}
                <div className="sbx-skills-cell sbx-skills-agents">
                  {access !== false &&
                    sources.map((source) => {
                      const entries = skillsEntries(source, kind, state.skills);
                      const what = entries.map((entry) => `${entry.host} → ${entry.target}`).join(", ");
                      return (
                        <span
                          key={source.agentId}
                          className={entries.length > 0 ? "sbx-skills-agent" : "sbx-skills-agent dimmed"}
                          title={`${source.displayName}: ${what || "nothing on this machine"}`}
                        >
                          <AgentIcon agentId={source.agentId} />
                        </span>
                      );
                    })}
                </div>
                <div className="sbx-skills-cell">
                  {access !== false && <Dropdown value={access} options={ACCESS_OPTIONS} onChange={(value) => setSkills(kind, value)} />}
                </div>
                {access !== false && folder !== undefined && (
                  // No remove: "Each agent's own" drops the folder.
                  <div className="sbx-skills-folder">
                    <PathInput
                      value={folder}
                      pickTitle="Bring skills from a folder"
                      onChange={setSkillsFolder}
                      pickedOnly
                      placeholder="No folder chosen"
                    />
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      </FieldGroup>
    );
  }

  if (section === "ports") {
    const ports = typedRows("port", BLANK_PORT, (change) => update("ports", change));
    return (
      <RowSection
        label="Port forwarding"
        rows={state.ports}
        renderRow={(port) => {
          const setPort = (change: Partial<typeof port>): void => update("ports", (rows) => patched(rows, port.id, change));
          return (
            <EditRow key={port.id} mark={portMark(port, problems)} {...ports.remove(port.id)}>
              <RowInput width="port" placeholder="3000" value={port.host} onChange={(host) => setPort({ host })} />
              <span className="sbx-arrow">→</span>
              <RowInput width="port" placeholder="3000" value={port.container} onChange={(container) => setPort({ container })} />
            </EditRow>
          );
        }}
        add={ports.add}
      />
    );
  }

  if (section === "mcp") {
    return (
      <SbxMcpSection
        rows={state.mcp}
        registered={mcpRegistered}
        ask={askMcp}
        setRows={(change) => update("mcp", change)}
        markOf={(row, failure) => mcpMark(row, state.mcp, problems, mcpRegistered, failure)}
        onSignIn={signInMcp}
        signingIn={signingInMcp}
      />
    );
  }

  if (section === "paths") {
    return (
      <RowSection
        label="Allowed paths"
        empty="No paths shared yet"
        rows={state.paths}
        renderRow={(row) => (
          <EditRow
            key={row.id}
            mark={problemOf(problems, "paths", row.path)}
            remove="Remove path"
            onRemove={() => update("paths", (paths) => without(paths, row.id))}
          >
            {/* Plain text: the path is what the picker returned. */}
            <span className="sbx-path-value" title={row.path}>
              {row.path}
            </span>
            <Dropdown
              value={row.access}
              options={ACCESS_OPTIONS}
              onChange={(access) => update("paths", (paths) => patched(paths, row.id, { access }))}
            />
          </EditRow>
        )}
        add={
          // Two "+ Add": a folder and a file are two native pickers, which cannot be one dialog off
          // macOS (see the projects:pick-file handler).
          <FieldRow>
            <ActionLink onClick={() => void addPath(window.tet.projects.pickDirectory("Allow a folder in the sandbox"))}>
              + Add folder
            </ActionLink>
            <ActionLink onClick={() => void addPath(window.tet.projects.pickFile("Allow a file in the sandbox"))}>+ Add file</ActionLink>
          </FieldRow>
        }
      />
    );
  }

  if (section === "variables") {
    const variables = typedRows("variable", BLANK_VARIABLE, (change) => update("variables", change));
    return (
      <RowSection
        label="Variables"
        rows={state.variables}
        renderRow={(row) => {
          const setVariable = (change: Partial<typeof row>): void => update("variables", (rows) => patched(rows, row.id, change));
          const valueStored = holdsValue(row, stored.variables);
          return (
            <EditRow key={row.id} mark={variableMark(row, state, problems)} {...variables.remove(row.id)}>
              <RowInput
                placeholder="NPM_TOKEN"
                title="The environment variable the sandbox sees, holding the value itself"
                value={row.env}
                onChange={(env) => setVariable({ env })}
              />
              <SecretInput
                stored={valueStored}
                storedTitle="Stored on this machine; typing replaces it. The sandbox sees it."
                emptyTitle="Stored on this machine, never in tet.json. The sandbox sees it."
                value={row.value}
                onChange={(value) => setVariable({ value })}
              />
            </EditRow>
          );
        }}
        add={variables.add}
      />
    );
  }

  if (section === "setup") {
    return (
      <FieldGroup label="Setup script">
        <CodeField
          className="sbx-setup"
          language="shellscript"
          placeholder={"apt-get update\napt-get install -y ffmpeg"}
          value={state.setup}
          onChange={(setup) => update("setup", () => setup)}
        />
        <p className="dialog-detail">
          Runs once per sandbox when its first tab starts, and again after every change. Write it so that running it twice does no harm.
        </p>
      </FieldGroup>
    );
  }

  const hosts = typedRows("host", BLANK_HOST, (change) => update("hosts", change));
  return (
    <RowSection
      label="Allowed hosts"
      rows={state.hosts}
      renderRow={(row) => (
        <EditRow key={row.id} mark={problemOf(problems, "hosts", row.host.trim())} {...hosts.remove(row.id)}>
          <RowInput
            placeholder="api.example.com"
            title="Exact host, *.example.com, or host:443"
            value={row.host}
            onChange={(host) => update("hosts", (rows) => patched(rows, row.id, { host }))}
          />
        </EditRow>
      )}
      add={hosts.add}
    />
  );
}
