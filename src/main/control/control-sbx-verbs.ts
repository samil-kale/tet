import * as path from "node:path";
import type { ControlRequest, ControlVerbName } from "../../shared/control";
import type { Project } from "../../shared/types/project";
import type { SbxKnowledgeSettings, SbxProjectSettings, SbxSecret, SbxVariable } from "../../shared/types/sbx";
import { SBX_ACCESS } from "../../shared/types/sbx";
import {
  SBX_KNOWLEDGE_KINDS,
  keptValues,
  sbxNeedsRestart,
  sbxPortRefusal,
  sbxSecretRefusal,
  sbxVariableRefusal,
  withoutProblems
} from "../../shared/sbx-rules";
import { sbxBlocked, sbxNotReady } from "../sbx/sbx-policy";
import type { ControlDeps } from "./control-verb";
import type { SbxReading } from "../sbx/sbx-status";
import { ControlError, list, onOff, oneOf, optionalText, text, type Answer, type Handler, type RefFrom } from "./control-verb";
import { PLATFORM } from "../util/host-platform";

/**
 * The SBX Settings verbs: `sbx-get` and one `sbx-set-*` per field, each a Save as the dialog's
 * (ControlDeps.sbx). `refFrom` is the server's lookup of the repository or worktree a verb acts on
 * (resolveCallerRef).
 */
export function sbxVerbs(
  deps: ControlDeps,
  refFrom: RefFrom
): Record<Extract<ControlVerbName, `sbx-${string}`>, Handler> {
  const project = (args: Record<string, unknown>, caller: ControlRequest["caller"]): Project => refFrom(args, caller).project;
  /** What the SBX Settings dialog waits for before it shows its fields (SbxSettingsDialog's setup),
   *  which only the user can set up there. Returns what it read, for the Save to take the
   *  organization from. */
  const readySbx = async (found: Project): Promise<SbxReading> => {
    const reading = await deps.sbx.status(found);
    const { status } = reading;
    const missing = sbxNotReady(status);
    if (missing) {
      throw new ControlError("bad_args", `${missing}: the user sets it up in ${found.name}'s SBX Settings in TET`);
    }
    const blocked = sbxBlocked(status.blockers, status.organization);
    if (blocked !== undefined) {
      throw new ControlError("bad_args", blocked);
    }
    return reading;
  };

  /**
   * One SBX Settings field changed, then saved as the dialog's Save does, everything else as it
   * stands: a row that cannot be applied here is left out and answered as `notApplied`. As the
   * dialog's tabs: only once sbx is ready (readySbx), and nothing but the switch while SBX is disabled.
   * A stored value stays with its row's name; a removed row's goes. Refused for a worktree
   * before anything is read, as it takes its project's (tet-json.ts's configRoot).
   */
  const editSbx = async (
    args: Record<string, unknown>,
    caller: ControlRequest["caller"],
    edit: (loaded: { settings: SbxProjectSettings; knowledge: SbxKnowledgeSettings }) => {
      settings?: SbxProjectSettings;
      knowledge?: SbxKnowledgeSettings;
      variableValues?: Record<string, string>;
    },
    switching = false
  ): Promise<Answer> => {
    const { project: found, ref } = refFrom(args, caller);
    if (ref.worktree !== undefined) {
      throw new ControlError(
        "bad_args",
        `a worktree takes its SBX Settings from its project ${found.name}: change them there (--project ${found.id})`
      );
    }
    const reading = await readySbx(found);
    const settings = await deps.sbx.settings(found);
    const { knowledge } = deps.sbx.stored(found.id);
    if (!settings.enabled && !switching) {
      throw new ControlError("bad_args", `SBX is disabled for ${found.name}: sbx-set-enabled on first`);
    }
    const next = edit({ settings, knowledge });
    const request = next.settings ?? settings;
    const nextKnowledge = next.knowledge ?? knowledge;
    const saved = await deps.sbx.save(
      found,
      request,
      {
        secrets: keptValues(request.secrets),
        variables: { ...keptValues(request.variables), values: next.variableValues ?? {} },
        knowledge: nextKnowledge
      },
      reading
    );
    if (!saved.ok) {
      throw new ControlError("internal", saved.error ?? "could not save the SBX Settings");
    }
    const problems = saved.problems ?? {};
    const applied = withoutProblems(request, nextKnowledge, problems);
    const restartRequired = sbxNeedsRestart(settings, knowledge, applied.settings, applied.knowledge);
    return { result: { saved: true, restartRequired, ...(Object.keys(problems).length > 0 ? { notApplied: problems } : {}) } };
  };

  /** Refuses the first variable that cannot be saved beside those before it and the secrets
   *  (sbxVariableRefusal), names compared as this machine does. */
  const refuseVariables = (variables: SbxVariable[], secrets: SbxSecret[]): void => {
    variables.forEach((variable, index) => {
      const refusal = sbxVariableRefusal(variable, variables.slice(0, index), secrets, PLATFORM.envNamesIgnoreCase);
      if (refusal) {
        throw new ControlError("bad_args", `${refusal}: ${variable.env}`);
      }
    });
  };

  /** An absolute path of this machine, as the dialog's folder picker gives one. */
  const absolute = (value: string): string => {
    if (!path.isAbsolute(value)) {
      throw new ControlError("bad_args", `not an absolute path: ${value}`);
    }
    return value;
  };

  return {
    // The machine's, not a project's: one sbx ls says whether it is signed in (readSbxSignedIn).
    "sbx-accounts": async () => {
      const signedIn = await deps.sbx.signedIn();
      const account = signedIn ? await deps.sbx.signedInUser() : undefined;
      return {
        result: {
          signedIn,
          ...(account !== undefined ? { account } : {}),
          accounts: deps.sbx.accounts().map((kept) => kept.user)
        }
      };
    },

    "sbx-sign-in": async (args) => {
      const user = text(args, "user", "a Docker username");
      const account = deps.sbx.accounts().find((candidate) => candidate.user === user);
      if (!account) {
        throw new ControlError("bad_args", `no access token kept for ${user}: the user adds it in TET's SBX Settings`);
      }
      const result = await deps.sbx.signIn(account);
      if (!result.signedIn) {
        throw new ControlError("internal", result.error ?? "sbx login failed");
      }
      return {
        result: {
          signedIn: true,
          account: result.account?.user ?? user,
          ...(result.account ? {} : { notKept: result.error ?? "the access token could not be kept" })
        }
      };
    },

    "sbx-get": async (args, caller) => {
      const found = project(args, caller);
      const stored = deps.sbx.stored(found.id);
      const [reading, settings] = await Promise.all([deps.sbx.status(found), deps.sbx.settings(found)]);
      const problems = await deps.sbx.problems(found, settings, stored.knowledge, stored, reading);
      return { result: { status: reading.status, settings, stored, problems } };
    },

    "sbx-set-enabled": async (args, caller) => {
      const enabled = onOff(args, "value");
      // As the dialog's switch, locked where no agent runs on this machine.
      if (!enabled && !(await deps.sbx.anyAgentInstalled())) {
        throw new ControlError("bad_args", "no agent is installed on this machine, so SBX cannot be disabled");
      }
      return editSbx(args, caller, ({ settings }) => ({ settings: { ...settings, enabled } }), true);
    },

    "sbx-set-ports": (args, caller) => {
      const ports = list(args, "ports").map((entry) => {
        const [host, container, ...rest] = entry.split(":").map((side) => side.trim());
        if (rest.length > 0 || container === undefined) {
          throw new ControlError("bad_args", `not <host>:<container>: ${entry}`);
        }
        const refusal = sbxPortRefusal({ host, container });
        if (refusal) {
          throw new ControlError("bad_args", `${refusal}: ${entry}`);
        }
        return { host, container };
      });
      return editSbx(args, caller, ({ settings }) => ({ settings: { ...settings, ports } }));
    },

    "sbx-set-paths": (args, caller) => {
      const paths = list(args, "paths").map((entry) => {
        // The last colon: a Windows path has one of its own.
        const at = entry.lastIndexOf(":");
        const access = SBX_ACCESS.find((candidate) => candidate === entry.slice(at + 1));
        if (at < 0 || access === undefined) {
          throw new ControlError("bad_args", `not <path>:<ro|rw>: ${entry}`);
        }
        return { path: absolute(entry.slice(0, at)), access };
      });
      return editSbx(args, caller, ({ settings }) => ({ settings: { ...settings, paths } }));
    },

    "sbx-set-hosts": (args, caller) => {
      const hosts = list(args, "hosts")
        .map((host) => host.trim())
        .filter(Boolean);
      return editSbx(args, caller, ({ settings }) => ({ settings: { ...settings, hosts } }));
    },

    "sbx-set-secrets": (args, caller) => {
      const secrets = list(args, "secrets").map((entry) => {
        const at = entry.indexOf("=");
        if (at < 0) {
          throw new ControlError("bad_args", `not <NAME>=<host>[,<host>...]: ${entry}`);
        }
        const hosts = entry
          .slice(at + 1)
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean);
        return { env: entry.slice(0, at).trim(), hosts };
      });
      secrets.forEach((secret, index) => {
        const refusal = sbxSecretRefusal(secret, secrets.slice(0, index));
        if (refusal) {
          throw new ControlError("bad_args", `${refusal}: ${secret.env}`);
        }
      });
      return editSbx(args, caller, ({ settings }) => {
        refuseVariables(settings.variables, secrets);
        return { settings: { ...settings, secrets } };
      });
    },

    "sbx-set-variables": (args, caller) => {
      // `NAME=value` types a value as the dialog's field does (an empty one keeps the stored one);
      // the first `=` splits, so a value may hold more. Typing one here is no hole, from a sandbox
      // either: an agent there can already set any variable for its own processes, and these reach
      // only its project's sandboxes. A secret's value stays the user's.
      const entries = list(args, "variables").map((entry) => {
        const at = entry.indexOf("=");
        return at < 0 ? { env: entry.trim(), value: "" } : { env: entry.slice(0, at).trim(), value: entry.slice(at + 1) };
      });
      const variables = entries.map(({ env }) => ({ env }));
      const variableValues = Object.fromEntries(entries.filter(({ value }) => value !== "").map(({ env, value }) => [env, value]));
      return editSbx(args, caller, ({ settings }) => {
        refuseVariables(variables, settings.secrets);
        return { settings: { ...settings, variables }, variableValues };
      });
    },

    "sbx-set-knowledge": (args, caller) => {
      const kind = oneOf(args, "kind", "kind", SBX_KNOWLEDGE_KINDS);
      const access = oneOf(args, "access", "access", ["off", ...SBX_ACCESS]);
      return editSbx(args, caller, ({ knowledge }) => ({
        knowledge: { ...knowledge, [kind]: access === "off" ? false : access }
      }));
    },

    "sbx-set-skills-folder": (args, caller) => {
      const typed = optionalText(args, "path");
      const folder = typed === undefined ? undefined : absolute(typed);
      return editSbx(args, caller, ({ knowledge }) => {
        const next = { ...knowledge, skillsFolder: folder };
        if (folder === undefined) {
          delete next.skillsFolder;
        }
        return { knowledge: next };
      });
    }
  };
}
