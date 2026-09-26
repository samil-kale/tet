import { Fragment, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type {
  SbxAccess,
  SbxKnowledgeConfig,
  SbxKnowledgeEntry,
  SbxKnowledgeKind,
  SbxKnowledgeSource,
  SbxLocalEdits,
  SbxLocalSave,
  SbxPath,
  SbxPort,
  SbxProblems,
  SbxProjectConfig,
  SbxStoredLocal
} from "../../shared/types";
import { sbxNeedsRestart, sbxPortKey, sbxPortRefusal, sbxSecretRefusal, sbxVariableRefusal } from "../../shared/sbx-rules";
import { isWindows } from "../platform";
import { ActionLink } from "../ui/ActionLink";
import { atLeastOne, EditRow, patched, RowMark, RowSection, SecretInput, withId, without, type Row } from "../ui/RowSection";
import { Dropdown } from "../ui/Dropdown";
import { Checkbox, FieldGroup, PathInput } from "../ui/Field";
import { AgentIcon } from "../ui/agent-icons";

const ACCESS_OPTIONS: { value: SbxAccess; label: string }[] = [
  { value: "ro", label: "Read" },
  { value: "rw", label: "Read+Write" }
];

/** Where the skills come from: `SbxKnowledgeConfig.skillsFolder` absent, or set. */
type SkillsSource = "agents" | "folder";

const SKILLS_SOURCE_OPTIONS: { value: SkillsSource; label: string }[] = [
  { value: "agents", label: "Each agent's own" },
  { value: "folder", label: "A folder" }
];

/** One row per `SbxKnowledgeKind`, in display order. Labels only; the per-agent host paths are
 *  `AgentDefinition.sandboxKnowledge`. */
const KNOWLEDGE_LABELS: { kind: SbxKnowledgeKind; label: string }[] = [
  { kind: "skills", label: "Skills" },
  { kind: "plugins", label: "Plugins" },
  { kind: "instructions", label: "CLAUDE.md / AGENTS.md" }
];

/** How long typing pauses before the rows are checked again (useSbxProblems). */
const CHECK_DELAY_MS = 500;

export interface FieldsState {
  /** This machine's (`sbx:stored`); what each kind mounts is `AgentDefinition.sandboxKnowledge`.
   *  `skillsFolder` is "" while "A folder" is chosen and none picked yet. */
  knowledge: SbxKnowledgeConfig;
  ports: Row<SbxPort>[];
  paths: Row<SbxPath>[];
  hosts: Row<{ host: string }>[];
  /** `hosts` as typed, comma-separated; `value` only what was typed since opening — a stored one
   *  never reaches the renderer; `from` the name a row was opened under (SbxLocalEdits). */
  secrets: Row<{ env: string; hosts: string; value: string; from?: string }>[];
  /** `value` and `from` as for `secrets`. */
  variables: Row<{ env: string; value: string; from?: string }>[];
}

/** A typed section's row as "+ Add" makes it, and as one stands in where the section has none
 *  (`atLeastOne`); the paths come from a picker and have none. */
const BLANK_PORT = { host: "", container: "" };
const BLANK_HOST = { host: "" };
const BLANK_SECRET = { env: "", hosts: "", value: "" };
const BLANK_VARIABLE = { env: "", value: "" };

/** `sbx:get-config`'s and `sbx:stored`'s answers as rows. Only the user's paths: tet's directories
 *  and each agent's session directory are always mounted (sbx.ts's fixedMountSpecs,
 *  sessionMountSpecs), not shown. */
export function fromConfig(config: SbxProjectConfig, stored: SbxStoredLocal): FieldsState {
  return {
    knowledge: stored.knowledge,
    ports: atLeastOne(config.ports.map(withId), BLANK_PORT),
    paths: config.paths.map(withId),
    hosts: atLeastOne(
      config.hosts.map((host) => withId({ host })),
      BLANK_HOST
    ),
    secrets: atLeastOne(
      config.secrets.map((secret) =>
        withId({ env: secret.env, hosts: secret.hosts.join(", "), value: "", from: secret.env })
      ),
      BLANK_SECRET
    ),
    variables: atLeastOne(
      config.variables.map((variable) => withId({ env: variable.env, value: "", from: variable.env })),
      BLANK_VARIABLE
    )
  };
}

/** Why Save refuses a port row, or `undefined`: two empty sides are dropped instead. */
function portRefusal(row: SbxPort): string | undefined {
  return row.host.trim() === "" && row.container.trim() === "" ? undefined : sbxPortRefusal(row);
}

type SecretRow = FieldsState["secrets"][number];

function secretHosts(row: SecretRow): string[] {
  return row.hosts
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

function isEmptySecretRow(row: SecretRow): boolean {
  return row.env.trim() === "" && row.hosts.trim() === "" && row.value === "";
}

/** A row's name, as Save keeps it, for another row's rules. */
function named(row: { env: string }): { env: string; hosts: string[] } {
  return { env: row.env.trim(), hosts: [] };
}

/** Why Save refuses a secret row (sbxSecretRefusal), or `undefined`: an empty one is dropped. */
function secretRefusal(row: SecretRow, rows: SecretRow[]): string | undefined {
  return isEmptySecretRow(row)
    ? undefined
    : sbxSecretRefusal({ env: row.env.trim(), hosts: secretHosts(row) }, rows.filter((other) => other.id !== row.id).map(named));
}

type VariableRow = FieldsState["variables"][number];

function isEmptyVariableRow(row: VariableRow): boolean {
  return row.env.trim() === "" && row.value === "";
}

/** Why Save refuses a variable row (sbxVariableRefusal), or `undefined`: an empty one is dropped. */
function variableRefusal(row: VariableRow, state: FieldsState): string | undefined {
  return isEmptyVariableRow(row)
    ? undefined
    : sbxVariableRefusal(
        named(row),
        state.variables.filter((other) => other.id !== row.id).map(named),
        state.secrets.map(named),
        isWindows()
      );
}

/** Why Save waits, or `undefined`: every port row two ports or empty, every secret and variable row
 *  complete or empty — the rows mark which is not — and skills from a folder with one picked. */
export function saveBlocked(state: FieldsState): string | undefined {
  if (state.ports.some((row) => portRefusal(row) !== undefined)) {
    return "A port on the Ports tab is not a whole number from 1 to 65535";
  }
  if (state.secrets.some((row) => secretRefusal(row, state.secrets) !== undefined)) {
    return "A secret on the Secrets tab needs a variable name of its own and hosts without scheme or port";
  }
  if (state.variables.some((row) => variableRefusal(row, state) !== undefined)) {
    return "A variable on the Variables tab needs a name no secret or other variable holds, not PATH or TET_*";
  }
  if (state.knowledge.skills !== false && state.knowledge.skillsFolder === "") {
    return "The skills on the Knowledge tab need a folder";
  }
  return undefined;
}

/** The inverse, for Save: ids dropped, as are empty port, host, secret and variable rows. */
export function toConfig(state: FieldsState): Omit<SbxProjectConfig, "enabled"> {
  return {
    ports: state.ports
      .map(({ host, container }) => ({ host: host.trim(), container: container.trim() }))
      .filter((port) => port.host && port.container),
    paths: state.paths.map(({ path, access }) => ({ path, access })),
    hosts: state.hosts.map(({ host }) => host.trim()).filter(Boolean),
    secrets: state.secrets
      .filter((row) => !isEmptySecretRow(row))
      .map((row) => ({ env: row.env.trim(), hosts: secretHosts(row) })),
    variables: state.variables.filter((row) => !isEmptyVariableRow(row)).map((row) => ({ env: row.env.trim() }))
  };
}

/** One list's rows as Save stores them on this machine; a row left without a name holds nothing. */
function toLocalEdits(rows: { env: string; value: string; from?: string }[]): SbxLocalEdits {
  const named = rows.filter((row) => row.env.trim() !== "");
  return {
    values: Object.fromEntries(named.filter((row) => row.value !== "").map((row) => [row.env.trim(), row.value])),
    from: Object.fromEntries(named.flatMap((row) => (row.from === undefined ? [] : [[row.env.trim(), row.from]])))
  };
}

/** The knowledge as Save stores it: "A folder" with none picked, while skills are off, is each
 *  agent's own (saveBlocked refuses it while they are on). */
function toKnowledge(knowledge: SbxKnowledgeConfig): SbxKnowledgeConfig {
  const { skillsFolder, ...kinds } = knowledge;
  return skillsFolder ? knowledge : kinds;
}

/** The values typed since opening and each row's name when opened (SbxLocalEdits), and the
 *  knowledge, for Save. */
export function toLocalSave(state: FieldsState): SbxLocalSave {
  return {
    secrets: toLocalEdits(state.secrets),
    variables: toLocalEdits(state.variables),
    knowledge: toKnowledge(state.knowledge)
  };
}

/** What `source` mounts for `kind`, for its icon: its own, or for skills the chosen folder. */
function knowledgeEntries(source: SbxKnowledgeSource, kind: SbxKnowledgeKind, knowledge: SbxKnowledgeConfig): SbxKnowledgeEntry[] {
  const folder = knowledge.skillsFolder;
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
export function needsRestart(loaded: SbxProjectConfig, loadedKnowledge: SbxKnowledgeConfig, state: FieldsState): boolean {
  return (
    sbxNeedsRestart(loaded, loadedKnowledge, toConfig(state), toKnowledge(state.knowledge)) ||
    state.variables.some((row) => row.value !== "")
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
 * marked from the start, its tab too — then again once typing pauses on a change (~0.5 s an sbx
 * call). An answer overtaken by an edit is dropped. Save leaves such a row out.
 */
export function useSbxProblems(projectId: string, state: FieldsState, stored: SbxStoredLocal, ready: boolean): SbxProblems {
  const [problems, setProblems] = useState<SbxProblems>({});
  const config = { enabled: true, ...toConfig(state) };
  const knowledge = toKnowledge(state.knowledge);
  const values = { secrets: valueNames(state.secrets, stored.secrets), variables: valueNames(state.variables, stored.variables) };
  const key = JSON.stringify([config, knowledge, values]);
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
      void window.tet.sbx.problems(projectId, config, knowledge, values).then(
        (answer) => {
          if (current) {
            setProblems(answer);
          }
        },
        () => undefined
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

/** Who refuses, in the dialog's blocked message. */
export function policyName(governed: boolean): string {
  return governed ? "Your organization's SBX policy" : "SBX's policy";
}

/** A port row's mark, or `undefined`: why Save refuses it before why it cannot be applied here. */
function portMark(row: FieldsState["ports"][number], problems: SbxProblems): string | undefined {
  return portRefusal(row) ?? problems.ports?.[sbxPortKey({ host: row.host.trim(), container: row.container.trim() })];
}

/** A secret row's mark, or `undefined`, likewise. */
function secretMark(row: SecretRow, rows: SecretRow[], problems: SbxProblems): string | undefined {
  return secretRefusal(row, rows) ?? problems.secrets?.[row.env.trim()];
}

/** A variable row's mark, or `undefined`, likewise. */
function variableMark(row: VariableRow, state: FieldsState, problems: SbxProblems): string | undefined {
  return variableRefusal(row, state) ?? problems.variables?.[row.env.trim()];
}

/** Each tab's mark: its first marked row's, repeated on the tab so it shows from any pane. */
export function tabMarks(state: FieldsState, problems: SbxProblems): Partial<Record<keyof FieldsState, string>> {
  const first = (marks: (string | undefined)[]): string | undefined => marks.find((mark) => mark !== undefined);
  return {
    knowledge: first(KNOWLEDGE_LABELS.map(({ kind }) => problems.knowledge?.[kind])),
    ports: first(state.ports.map((row) => portMark(row, problems))),
    paths: first(state.paths.map((row) => problems.paths?.[row.path])),
    hosts: first(state.hosts.map((row) => problems.hosts?.[row.host.trim()])),
    secrets: first(state.secrets.map((row) => secretMark(row, state.secrets, problems))),
    variables: first(state.variables.map((row) => variableMark(row, state, problems)))
  };
}

interface SbxSettingsFieldsProps {
  /** Owned by SbxSettingsDialog, which builds the save request. */
  state: FieldsState;
  setState: Dispatch<SetStateAction<FieldsState>>;
  section: keyof FieldsState;
  /** The env names holding a value on this machine (`sbx:stored`); never a value. */
  stored: SbxStoredLocal;
  /** The agents installed here, for the Knowledge tab's icons (`sbx:knowledge-sources`). */
  sources: SbxKnowledgeSource[];
  /** Asked by the dialog from its opening (useSbxProblems), for the tabs' marks too. */
  problems: SbxProblems;
}

/** One tab of the dialog's fields, shown once sbx is ready (see SbxSettingsDialog). State is
 *  shared across tabs. */
export function SbxSettingsFields({ state, setState, section, stored, sources, problems }: SbxSettingsFieldsProps) {
  const update = <K extends keyof FieldsState>(key: K, change: (value: FieldsState[K]) => FieldsState[K]): void =>
    setState((current) => ({ ...current, [key]: change(current[key]) }));

  /** `false` turns a kind off; an `SbxAccess` turns it on with that access. */
  const setKnowledge = (kind: SbxKnowledgeKind, value: SbxAccess | false): void =>
    update("knowledge", (knowledge) => ({ ...knowledge, [kind]: value }));
  /** "A folder" shows the picker's row, empty until a folder is picked. */
  const setSkillsFolder = (folder: string | undefined): void =>
    update("knowledge", (knowledge) => {
      const next = { ...knowledge, skillsFolder: folder };
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

  if (section === "knowledge") {
    return (
      <FieldGroup label="Bring from this machine">
        <div className="sbx-knowledge-rows">
          {KNOWLEDGE_LABELS.map(({ kind, label }) => {
            const access = state.knowledge[kind];
            const skills = kind === "skills";
            const folder = skills ? state.knowledge.skillsFolder : undefined;
            return (
              <Fragment key={kind}>
                {/* Only skills have a source; the other labels take its column too. */}
                <div className={skills ? "sbx-knowledge-cell" : "sbx-knowledge-cell sbx-knowledge-wide"}>
                  <Checkbox
                    label={label}
                    checked={access !== false}
                    onChange={(next) => setKnowledge(kind, next ? "ro" : false)}
                  />
                  <RowMark title={problems.knowledge?.[kind]} />
                </div>
                {skills && (
                  <div className="sbx-knowledge-cell">
                    {access !== false && (
                      <Dropdown
                        value={folder === undefined ? "agents" : "folder"}
                        options={SKILLS_SOURCE_OPTIONS}
                        onChange={(value) => setSkillsFolder(value === "folder" ? (folder ?? "") : undefined)}
                      />
                    )}
                  </div>
                )}
                <div className="sbx-knowledge-cell sbx-knowledge-agents">
                  {sources.map((source) => {
                    const entries = knowledgeEntries(source, kind, state.knowledge);
                    const what = entries.map((entry) => `${entry.host} → ${entry.target}`).join(", ");
                    return (
                      <span
                        key={source.agentId}
                        className={access !== false && entries.length > 0 ? "sbx-knowledge-agent" : "sbx-knowledge-agent dimmed"}
                        title={`${source.displayName}: ${what || "nothing on this machine"}`}
                      >
                        <AgentIcon agentId={source.agentId} />
                      </span>
                    );
                  })}
                </div>
                <div className="sbx-knowledge-cell">
                  {access !== false && (
                    <Dropdown value={access} options={ACCESS_OPTIONS} onChange={(value) => setKnowledge(kind, value)} />
                  )}
                </div>
                {access !== false && folder !== undefined && (
                  // No remove: "Each agent's own" drops the folder.
                  <div className="sbx-knowledge-folder">
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
    return (
      <RowSection
        label="Port forwarding"
        rows={state.ports}
        renderRow={(port) => {
          const setPort = (change: Partial<typeof port>): void =>
            update("ports", (ports) => patched(ports, port.id, change));
          return (
            <EditRow
              key={port.id}
              mark={portMark(port, problems)}
              remove="Remove port"
              onRemove={() => update("ports", (ports) => atLeastOne(without(ports, port.id), BLANK_PORT))}
            >
              <input
                className="sbx-port-input"
                type="text"
                inputMode="numeric"
                placeholder="3000"
                value={port.host}
                onChange={(event) => setPort({ host: event.target.value })}
              />
              <span className="sbx-arrow">→</span>
              <input
                className="sbx-port-input"
                type="text"
                inputMode="numeric"
                placeholder="3000"
                value={port.container}
                onChange={(event) => setPort({ container: event.target.value })}
              />
            </EditRow>
          );
        }}
        add={
          <ActionLink onClick={() => update("ports", (ports) => [...ports, withId(BLANK_PORT)])}>
            + Add port
          </ActionLink>
        }
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
            mark={problems.paths?.[row.path]}
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
          <div className="sbx-add-paths">
            <ActionLink onClick={() => void addPath(window.tet.projects.pickDirectory("Allow a folder in the sandbox"))}>
              + Add folder
            </ActionLink>
            <ActionLink onClick={() => void addPath(window.tet.projects.pickFile("Allow a file in the sandbox"))}>
              + Add file
            </ActionLink>
          </div>
        }
      />
    );
  }

  if (section === "secrets") {
    return (
      <RowSection
        label="Secrets"
        rows={state.secrets}
        renderRow={(row) => {
          const setSecret = (change: Partial<typeof row>): void =>
            update("secrets", (secrets) => patched(secrets, row.id, change));
          const valueStored = holdsValue(row, stored.secrets);
          return (
            <EditRow
              key={row.id}
              mark={secretMark(row, state.secrets, problems)}
              remove="Remove secret"
              onRemove={() => update("secrets", (secrets) => atLeastOne(without(secrets, row.id), BLANK_SECRET))}
            >
              <input
                className="row-fixed-input"
                type="text"
                placeholder="GITLAB_TOKEN"
                title="The environment variable the sandbox sees, holding a placeholder instead of the value"
                value={row.env}
                onChange={(event) => setSecret({ env: event.target.value })}
              />
              <input
                className="row-fill-input"
                type="text"
                placeholder="gitlab.example.com"
                title="Where sbx puts the value in place of the placeholder, in request headers only: exact host or *.example.com, comma-separated, no scheme or port"
                value={row.hosts}
                onChange={(event) => setSecret({ hosts: event.target.value })}
              />
              <SecretInput
                stored={valueStored}
                storedTitle="Stored on this machine; typing replaces it. The sandbox never sees it."
                emptyTitle="Stored on this machine, never in tet.json. The sandbox never sees it."
                value={row.value}
                onChange={(value) => setSecret({ value })}
              />
            </EditRow>
          );
        }}
        add={
          <ActionLink
            onClick={() => update("secrets", (secrets) => [...secrets, withId(BLANK_SECRET)])}
          >
            + Add secret
          </ActionLink>
        }
      />
    );
  }

  if (section === "variables") {
    return (
      <RowSection
        label="Variables"
        rows={state.variables}
        renderRow={(row) => {
          const setVariable = (change: Partial<typeof row>): void =>
            update("variables", (variables) => patched(variables, row.id, change));
          const valueStored = holdsValue(row, stored.variables);
          return (
            <EditRow
              key={row.id}
              mark={variableMark(row, state, problems)}
              remove="Remove variable"
              onRemove={() => update("variables", (variables) => atLeastOne(without(variables, row.id), BLANK_VARIABLE))}
            >
              <input
                className="row-fill-input"
                type="text"
                placeholder="NPM_TOKEN"
                title="The environment variable the sandbox sees, holding the value itself"
                value={row.env}
                onChange={(event) => setVariable({ env: event.target.value })}
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
        add={
          <ActionLink onClick={() => update("variables", (variables) => [...variables, withId(BLANK_VARIABLE)])}>
            + Add variable
          </ActionLink>
        }
      />
    );
  }

  return (
    <RowSection
      label="Allowed hosts"
      rows={state.hosts}
      renderRow={(row) => (
        <EditRow
          key={row.id}
          mark={problems.hosts?.[row.host.trim()]}
          remove="Remove host"
          onRemove={() => update("hosts", (hosts) => atLeastOne(without(hosts, row.id), BLANK_HOST))}
        >
          <input
            className="row-fill-input"
            type="text"
            placeholder="api.example.com"
            title="Exact host, *.example.com, or host:443"
            value={row.host}
            onChange={(event) => update("hosts", (hosts) => patched(hosts, row.id, { host: event.target.value }))}
          />
        </EditRow>
      )}
      add={
        <ActionLink onClick={() => update("hosts", (hosts) => [...hosts, withId(BLANK_HOST)])}>+ Add host</ActionLink>
      }
    />
  );
}
