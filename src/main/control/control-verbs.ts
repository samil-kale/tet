import * as path from "node:path";
import { HELP_VERB, HOOK_EVENTS, TAB_KEYS } from "../../shared/control";
import type { ControlRequest, ControlVerbName } from "../../shared/control";
import { KEYBINDING_PRESETS } from "../../shared/keybinding-presets";
import { THEMES, themeKey } from "../../shared/themes";
import { projectRefKey, projectRefsOf, sameProjectRef } from "../../shared/types/project";
import { COLOR_SCHEMES, LANES, NOTIFICATION_IDS, PROMPT_IDS, withLanePinned } from "../../shared/types/settings";
import { isWorking, TERMINAL_STATUSES } from "../../shared/types/terminals";
import type { Project, ProjectRef } from "../../shared/types/project";
import type { AgentDefinition } from "../agents/agent";
import type { InspectedTab } from "../terminals/session-manager";
import { isEnvName, reservedRefusal } from "../../shared/env-rules";
import { machineName } from "../store/env-names";
import { repositoryRelative } from "../util/path-inside";
import { sbxVerbs } from "./control-sbx-verbs";
import { worktreeVerbs } from "./control-worktree-verbs";
import {
  callerRef,
  ControlError,
  count,
  list,
  onOff,
  oneOf,
  optionalText,
  refuseUnsaved,
  repositoryOf,
  resolveCallerRef,
  text,
  type Caller,
  type ControlDeps,
  type ControlTerminals,
  type Handler,
  type RefFrom
} from "./control-verb";

/** `tabs-wait` default timeout and poll interval. */
const WAIT_TIMEOUT_S = 30;
const WAIT_POLL_MS = 100;
/** `events-tail` default. */
const EVENTS_TAIL = 50;
/** `tabs-output` default. */
const OUTPUT_KB = 16;
/** What `tabs-keys` presses, for its refusals. */
const KEY_NAMES = Object.keys(TAB_KEYS).join(", ");

/** Every verb's handler but `help`, which the CLI answers itself. */
type Handlers = Record<Exclude<ControlVerbName, typeof HELP_VERB>, Handler>;

export function verbs(deps: ControlDeps): Handlers {
  const { store, settings, sessions } = deps;

  const projectById = (id: string): Project => {
    const found = store.get(id);
    if (!found) {
      throw new ControlError("not_found", `unknown project: ${id}`);
    }
    return found;
  };

  const refFrom: RefFrom = (args, caller) => resolveCallerRef(store, args, caller);

  const terminals = (ref: ProjectRef): ControlTerminals => {
    const manager = sessions.get(ref);
    if (!manager) {
      throw new ControlError("internal", `${projectRefKey(ref)} has no terminals`);
    }
    return manager;
  };

  const repository = (ref: ProjectRef) => repositoryOf(deps, ref);

  /** A tab id checked to exist, with its repository or worktree and terminals. */
  const knownTab = (
    args: Record<string, unknown>,
    caller: ControlRequest["caller"]
  ): { tabs: ControlTerminals; tabId: string; ref: ProjectRef } => {
    const { ref } = refFrom(args, caller);
    const tabId = text(args, "tabId", "tab id");
    const tabs = terminals(ref);
    if (!tabs.snapshot().some((tab) => tab.tabId === tabId)) {
      throw new ControlError("not_found", `unknown tab: ${tabId} (see tabs-list)`);
    }
    return { tabs, tabId, ref };
  };

  /** `knownTab` for a verb acting on the tab: from a sandbox, only its own tab or one known to run in
   *  a sandbox — a host tab is this machine's, which a sandbox never reaches, and its output may
   *  print the host's control token. `own`: the caller's own tab. */
  const ownedTab = (args: Record<string, unknown>, caller: Caller) => {
    const known = knownTab(args, caller);
    const own = sameProjectRef(known.ref, callerRef(caller)) && known.tabId === caller.tabId;
    const tab = known.tabs.inspect().find((entry) => entry.tabId === known.tabId);
    if (!caller.side.reachesTab(tab, own)) {
      throw new ControlError("bad_args", `${known.tabId} runs on this machine, not in the sandbox`);
    }
    return { ...known, own };
  };

  /** `--agent` (or the positional `hint` names), one TET knows. */
  const knownAgent = (args: Record<string, unknown>, hint: string): AgentDefinition => {
    const id = text(args, "agent", hint);
    const agent = deps.agents.find((candidate) => candidate.id === id);
    if (!agent) {
      throw new ControlError("bad_args", `unknown agent: ${id} (see list-agents)`);
    }
    return agent;
  };

  /** `--agent`, one the caller may open a tab of: a shell would run on this machine, so a sandbox
   *  opens only an sbx agent's tab, held to the sandbox (createTab, handOff). */
  const openableAgent = (args: Record<string, unknown>, caller: Caller): AgentDefinition => {
    const agent = knownAgent(args, "agent: pass --agent <id> (see list-agents)");
    if (!caller.side.opens(agent)) {
      throw new ControlError("unauthorized", `a ${agent.id} tab does not run in a sandbox, so a sandbox cannot open one`);
    }
    return agent;
  };

  return {
    ...sbxVerbs(deps, refFrom),
    ...worktreeVerbs(deps, refFrom),

    version: () => ({ result: { version: deps.version, pid: deps.pid } }),

    "list-themes": () => ({ result: THEMES.map(({ id, label, kind }) => ({ id, label, kind })) }),

    "list-keybinding-presets": () => ({ result: KEYBINDING_PRESETS.map(({ id, label }) => ({ id, label })) }),

    "list-agents": async () => ({ result: await deps.listAgents() }),

    "settings-get": () => ({ result: settings.get() }),

    "settings-set-theme": (args) => {
      const id = text(args, "theme", "theme id");
      // The store keeps any string and silently falls back (settings.ts); refuse it here instead.
      const theme = THEMES.find((candidate) => candidate.id === id);
      if (!theme) {
        throw new ControlError("bad_args", `unknown theme: ${id} (see list-themes)`);
      }
      // Shown at once if the window is in that kind. The flag is for the agent to relay; restarting
      // is the user's call.
      return { result: { saved: true, restartRequired: settings.patch({ appearance: { [themeKey(theme.kind)]: id } }) } };
    },

    "settings-set-color-scheme": (args) => {
      const colorScheme = oneOf(args, "scheme", "color scheme", COLOR_SCHEMES);
      // A kind the window is not drawn in waits for a restart (main.ts's applyTheme).
      return { result: { saved: true, restartRequired: settings.patch({ appearance: { colorScheme } }) } };
    },

    "settings-set-lane-pin": (args) => {
      const lane = oneOf(args, "lane", "lane", LANES);
      const lanes = withLanePinned(settings.get().appearance.lanes, lane, onOff(args, "value"));
      // Shown at once (main.ts hands the window what the store then holds).
      settings.patch({ appearance: { lanes } });
      return { result: { saved: true } };
    },

    "settings-set-lane-order": (args) => {
      const order = list(args, "lanes").map((name) => oneOf({ lane: name }, "lane", "lane", LANES));
      if (order.length === 0) {
        throw new ControlError("bad_args", "missing lanes");
      }
      const twice = order.find((lane, index) => order.indexOf(lane) !== index);
      if (twice !== undefined) {
        throw new ControlError("bad_args", `lane named twice: ${twice}`);
      }
      // One left out joins at the end (settings.ts's normalize).
      settings.patch({ appearance: { lanes: { pinned: settings.get().appearance.lanes.pinned, order } } });
      return { result: { saved: true } };
    },

    "settings-set-prompt": (args) => {
      const id = oneOf(args, "id", "prompt", PROMPT_IDS);
      // No text resets: "" means tet's own prompt, read by ipc/repository.ts when asking.
      const value = args.text;
      settings.patch({ prompts: { texts: { [id]: typeof value === "string" ? value : "" } } });
      return { result: { saved: true } };
    },

    "settings-set-keybindings": (args) => {
      const id = text(args, "preset", "keybinding preset id");
      // The store keeps any string and the editor falls back (settings.ts); refuse it here instead.
      if (!KEYBINDING_PRESETS.some((preset) => preset.id === id)) {
        throw new ControlError("bad_args", `unknown keybinding preset: ${id} (see list-keybinding-presets)`);
      }
      // An editor reads its keybindings once, when it is made (editor-views.ts's editorSetup).
      settings.patch({ files: { editorKeybindingPreset: id } });
      return { result: { saved: true } };
    },

    "settings-set-notification": (args) => {
      const id = oneOf(args, "id", "notification", NOTIFICATION_IDS);
      settings.patch({ notifications: { [id]: onOff(args, "value") } });
      return { result: { saved: true } };
    },

    "settings-set-commit-suggester": async (args, caller) => {
      const agent = knownAgent(args, "agent id");
      const id = agent.id;
      if (!agent.ask) {
        throw new ControlError("bad_args", `${id} cannot suggest a commit message`);
      }
      const model = optionalText(args, "model") ?? "";
      // Listed where the caller's commit prompt would list them, which also says a missing agent.
      const { models, error } = await deps.askModels(agent, repository(refFrom(args, caller).ref).at.path);
      if (error !== undefined) {
        throw new ControlError("bad_args", error);
      }
      // Refused rather than stored: the commit prompt would put the default in its place.
      if (model !== "") {
        if (!models.some((candidate) => candidate.id === model)) {
          const known = models.map((candidate) => candidate.id).join(", ");
          throw new ControlError("bad_args", `unknown ${agent.displayName} model: ${model} (known: ${known})`);
        }
      }
      settings.patch({ prompts: { commitSuggester: { agentId: id, model } } });
      return { result: { saved: true } };
    },

    "projects-list": (_args, caller) => ({ result: caller.side.projects(store.list(), caller) }),

    "repo-state": (args, caller) => ({ result: repository(refFrom(args, caller).ref).getState() }),

    "projects-add": async (args) => {
      const added = await deps.addProject(text(args, "path", "path"));
      if (!added.project) {
        throw new ControlError("bad_args", added.error ?? "could not open the folder");
      }
      return { result: added.project };
    },

    "projects-remove": async (args, caller) => {
      const id = text(args, "projectId", "project id");
      const found = projectById(id);
      refuseUnsaved(deps, projectRefsOf(found), "nothing was removed");
      // What the window's question says (ProjectList's remove), here as a flag.
      const worktrees = found.worktrees.filter((worktree) => worktree.key !== undefined).length;
      if (worktrees > 0 && args.confirm !== true) {
        throw new ControlError(
          "bad_args",
          `removing ${found.name} deletes its ${worktrees} worktree${worktrees === 1 ? "" : "s"} with their branches. Ask the user, then pass --confirm.`
        );
      }
      // The caller's own project takes the caller's tab with it — answer first.
      if (caller.projectId === id) {
        return { result: { removed: id }, after: () => void deps.removeProject(id) };
      }
      const removed = await deps.removeProject(id);
      if (!removed.ok) {
        throw new ControlError("bad_args", removed.error ?? "could not remove the project");
      }
      return { result: { removed: id } };
    },

    "env-request": async (args, caller, _at, gone) => {
      const names = list(args, "names").filter((name) => name !== "");
      if (names.length === 0) {
        throw new ControlError("bad_args", "missing variable names: env-request NAME [NAME...]");
      }
      const invalid = names.find((name) => !isEnvName(name));
      if (invalid) {
        throw new ControlError("bad_args", `not an environment variable name: ${invalid}`);
      }
      const reserved = names.map(reservedRefusal).find((refusal) => refusal !== undefined);
      if (reserved) {
        throw new ControlError("bad_args", reserved);
      }
      // Once per variable as the machine counts them: on win32 `a` and `A` are one.
      const unique = names.filter((name, index) => names.findIndex((other) => machineName(other) === machineName(name)) === index);
      const saved = await deps.envRequests.ask(
        { ref: callerRef(caller), tabId: caller.tabId, names: unique },
        gone
      );
      return { result: saved === undefined ? { cancelled: true } : { saved, restartRequired: true } };
    },

    "env-list": () => ({ result: deps.environment.list() }),

    "env-remove": (args) => {
      const name = text(args, "name", "variable name");
      if (!deps.environment.remove(name)) {
        throw new ControlError("not_found", `TET keeps no environment variable named ${name}`);
      }
      return { result: { removed: name } };
    },

    // From a sandbox, only the tabs it reaches (ownedTab).
    "tabs-list": (args, caller) => {
      const { ref } = refFrom(args, caller);
      const own = sameProjectRef(ref, callerRef(caller));
      return { result: terminals(ref).inspect().filter((tab) => caller.side.reachesTab(tab, own && tab.tabId === caller.tabId)) };
    },

    "tabs-start": (args, caller) => {
      const { tabs, tabId } = ownedTab(args, caller);
      if (!tabs.start(tabId)) {
        throw new ControlError("bad_args", `tab ${tabId} is not waiting for its first start (see tabs-list; tabs-restart for one that stopped)`);
      }
      return { result: { started: tabId } };
    },

    "tabs-restart": (args, caller) => {
      const { tabs, tabId } = ownedTab(args, caller);
      if (!tabs.restart(tabId)) {
        throw new ControlError("bad_args", `tab ${tabId} has nothing to restart: it neither stopped nor failed to start (see tabs-list)`);
      }
      return { result: { restarted: tabId } };
    },

    "tabs-wait": async (args, caller, _at, gone) => {
      const { tabs, tabId } = ownedTab(args, caller);
      const status = args.status === undefined ? undefined : oneOf(args, "status", "status", TERMINAL_STATUSES);
      const conditions: [string, (tab: InspectedTab) => boolean][] = [];
      if (args.session === true) {
        conditions.push(["bound to a session", (tab) => tab.sessionId !== undefined]);
      }
      if (args.busy === true) {
        conditions.push(["working a turn", isWorking]);
      }
      if (args.idle === true) {
        conditions.push(["idle", (tab) => !isWorking(tab)]);
      }
      if (status !== undefined) {
        conditions.push([status, (tab) => tab.status === status]);
      }
      if (conditions.length === 0) {
        throw new ControlError("bad_args", "nothing to wait for: pass --session, --busy, --idle or --status <status>");
      }
      const deadline = Date.now() + count(args, "timeout", WAIT_TIMEOUT_S) * 1000;
      while (!gone.aborted) {
        const tab = tabs.inspect().find((candidate) => candidate.tabId === tabId);
        if (!tab) {
          throw new ControlError("not_found", `tab ${tabId} was closed while waiting`);
        }
        if (conditions.every(([, holds]) => holds(tab))) {
          return { result: tab };
        }
        if (Date.now() >= deadline) {
          const missing = conditions.filter(([, holds]) => !holds(tab)).map(([what]) => what);
          throw new ControlError("timeout", `tab ${tabId} is still not ${missing.join(" and not ")} (status ${tab.status})`);
        }
        await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
      }
      // Answered to no one.
      throw new ControlError("timeout", `stopped waiting for tab ${tabId}: the caller is gone`);
    },

    // One write per key: a TUI reads a burst of them as a paste.
    "tabs-keys": (args, caller) => {
      const { tabs, tabId } = ownedTab(args, caller);
      const keys = list(args, "keys");
      if (keys.length === 0) {
        throw new ControlError("bad_args", `missing keys: one or more of ${KEY_NAMES}`);
      }
      const unknown = keys.find((key) => !Object.hasOwn(TAB_KEYS, key));
      if (unknown !== undefined) {
        throw new ControlError("bad_args", `unknown key: ${unknown} (one of ${KEY_NAMES})`);
      }
      for (const key of keys) {
        tabs.write(tabId, TAB_KEYS[key]);
      }
      return { result: { pressed: tabId } };
    },

    // One write: the Enter that submits it is tabs-keys' own, which a TUI does not read as the paste.
    "tabs-text": (args, caller) => {
      const { tabs, tabId } = ownedTab(args, caller);
      tabs.write(tabId, text(args, "text", "text"));
      return { result: { typed: tabId } };
    },

    "tabs-output": async (args, caller) => {
      const { tabId, ref } = ownedTab(args, caller);
      const kb = count(args, "kb", OUTPUT_KB);
      const output = await deps.terminalText(ref, tabId);
      if (output === undefined) {
        throw new ControlError("internal", "the window did not answer: TET shows no terminals right now");
      }
      return { result: { output: output.slice(-kb * 1024) } };
    },

    // From a sandbox, only the events of tabs it reaches, as tabs-list — none of a closed tab, whose
    // side is no longer known.
    "events-tail": (args, caller) => {
      const { ref } = refFrom(args, caller);
      const own = sameProjectRef(ref, callerRef(caller));
      const tabs = terminals(ref);
      const inspected = tabs.inspect();
      const reached = tabs
        .events()
        .filter((event) => caller.side.reachesTab(inspected.find((tab) => tab.tabId === event.tabId), own && event.tabId === caller.tabId));
      return { result: reached.slice(-count(args, "tail", EVENTS_TAIL)) };
    },

    "editor-open": async (args, caller) => {
      const { ref } = refFrom(args, caller);
      const root = deps.projectRefPath(ref);
      if (root === undefined) {
        throw new ControlError("not_found", `${projectRefKey(ref)} is not open`);
      }
      const typed = text(args, "path", "path");
      const filePath = repositoryRelative(root, path.resolve(root, typed));
      if (filePath === undefined) {
        throw new ControlError("bad_args", `not inside the repository: ${typed}`);
      }
      const keep = args.keep === true;
      // In `after`, so a file the sandbox check refuses is never opened.
      return { result: { opened: filePath, keep }, after: () => deps.openEditor(ref, filePath, keep) };
    },

    "editor-state": async (args, caller) => {
      const { ref } = refFrom(args, caller);
      const report = deps.records.editor(ref);
      return { result: report ? { ...report, content: await deps.editorContent(ref) } : null };
    },

    "editor-list": (args, caller) => ({ result: deps.records.editors(refFrom(args, caller).ref) }),

    "explorer-list": async (args, caller) => ({ result: await repository(refFrom(args, caller).ref).listExplorer() }),

    "notices-list": () => ({ result: deps.records.notices() }),

    "tabs-create": (args, caller) => {
      const { ref } = refFrom(args, caller);
      const agent = openableAgent(args, caller);
      const prompt = args.prompt;
      if (prompt !== undefined && (typeof prompt !== "string" || prompt.trim() === "")) {
        throw new ControlError("bad_args", "missing text after --prompt");
      }
      if (prompt !== undefined && !agent.terminal) {
        throw new ControlError("bad_args", `a ${agent.id} tab takes no prompt`);
      }
      const tab = terminals(ref).createTab(agent.id, caller.side.holdsTabs, prompt);
      deps.showTab(ref, tab.tabId);
      return { result: tab };
    },

    "tabs-handoff": async (args, caller) => {
      const { tabs, tabId, ref } = ownedTab(args, caller);
      const handed = await tabs.handOff(tabId, openableAgent(args, caller).id, caller.side.holdsTabs);
      if (typeof handed === "string") {
        // A state the tab is in, not a mistyped call — as tabs-rename's refusal.
        throw new ControlError("internal", handed);
      }
      deps.showTab(ref, handed.tabId);
      return { result: handed };
    },

    "tabs-run-command": async (args, caller) => {
      const { project: found, ref } = refFrom(args, caller);
      const name = text(args, "name", "command name");
      const commands = await deps.readCommands(found.path);
      // By name or by the line itself — an agent reading tet.json may hold either.
      const command = commands.find((candidate) => candidate.name === name || candidate.command === name);
      if (!command) {
        throw new ControlError("not_found", `no saved command named ${name} in ${found.name}'s tet.json`);
      }
      const tab = terminals(ref).createCommandTab(command);
      if (!tab) {
        // createCommandTab already showed a notice saying why.
        throw new ControlError("bad_args", `${name} cannot be run without a shell — see the notice in TET`);
      }
      deps.showTab(ref, tab.tabId);
      return { result: tab };
    },

    "tabs-close": (args, caller) => {
      const { tabs, tabId, own } = ownedTab(args, caller);
      const close = (): void => void tabs.closeTabs([tabId]);
      // Closing the tab the CLI runs in kills the CLI — answer first.
      if (own) {
        return { result: { closed: tabId }, after: close };
      }
      close();
      return { result: { closed: tabId } };
    },

    "tabs-rename": async (args, caller) => {
      const { tabs, tabId } = ownedTab(args, caller);
      const refused = await tabs.renameTab(tabId, text(args, "title", "title"));
      if (refused !== undefined) {
        throw new ControlError("internal", refused);
      }
      return { result: { renamed: tabId } };
    },

    "restart-app": (args) => {
      if (args.confirm !== true) {
        throw new ControlError(
          "bad_args",
          "restart-app ends every terminal in every open project, this one included. Ask the user, then pass --confirm."
        );
      }
      return { result: { restarting: true }, after: () => deps.shutdown(true) };
    },

    notify: (args, caller) => {
      const body = args.body;
      // From one of tet's terminals, the toast is about that tab.
      const own = callerRef(caller);
      const target = own && caller.tabId ? { ref: own, tabId: caller.tabId } : undefined;
      deps.notify(text(args, "title", "title"), typeof body === "string" ? body : "", target);
      return { result: { notified: true } };
    },

    hook: (args, caller, at) => {
      const event = oneOf(args, "event", "hook event", HOOK_EVENTS);
      if (!caller.tabId) {
        throw new ControlError("bad_args", "a hook reports for the tab it runs in, and this is not one");
      }
      const payload = typeof args.payload === "string" ? args.payload : "";
      // The caller's own, never `--project`: the token vouches for its tab in its repository or
      // worktree only, and tab ids like `new-1` repeat across repositories and worktrees.
      const where = refFrom({}, caller).ref;
      const outcome = terminals(where).hookEvent(caller.tabId, event, payload, at, caller.side);
      if (outcome.toast) {
        deps.notify(outcome.toast.title, outcome.toast.body, { ref: where, tabId: caller.tabId });
      }
      return { result: { stdout: outcome.stdout } };
    }
  };
}

