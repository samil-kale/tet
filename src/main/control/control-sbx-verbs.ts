import * as path from "node:path";
import type { ControlRequest } from "../../shared/control";
import type {
  Project,
  SbxAccess,
  SbxKnowledgeConfig,
  SbxKnowledgeKind,
  SbxProjectConfig,
  SbxSecret,
  SbxStatus,
  SbxVariable
} from "../../shared/types";
import {
  SBX_KNOWLEDGE_KINDS,
  keptValues,
  sbxNeedsRestart,
  sbxPortRefusal,
  sbxSecretRefusal,
  sbxVariableRefusal,
  withoutProblems
} from "../../shared/sbx-rules";
import { sbxNotReady } from "../sbx-policy";
import type { ControlDeps } from "./control-server";
import { ControlError, list, text, type Answer, type Handler } from "./control-verb";

/**
 * The SBX Settings verbs: `sbx-get` and one `sbx-set-*` per field, each a Save as the dialog's
 * (ControlDeps.sbx). `project` is the server's lookup of the verb's project.
 */
export function sbxVerbs(
  deps: ControlDeps,
  project: (args: Record<string, unknown>, caller: ControlRequest["caller"]) => Project
): Record<string, Handler> {
  /** What the SBX Settings dialog waits for before it shows its fields (SbxSettingsDialog's setup),
   *  which only the user can set up there. Returns the status it read. */
  const readySbx = async (found: Project): Promise<SbxStatus> => {
    const status = await deps.sbx.status(found);
    const missing = sbxNotReady(status);
    if (missing) {
      throw new ControlError("bad_args", `${missing}: the user sets it up in ${found.name}'s SBX Settings in TET`);
    }
    if (status.blockers.length > 0) {
      const policy = status.organization ? `${status.organization}'s SBX policy` : "SBX's policy";
      throw new ControlError("bad_args", `${policy} does not allow ${status.blockers.map((blocker) => `${blocker.allow} (${blocker.what})`).join("; ")}`);
    }
    return status;
  };

  /**
   * One SBX Settings field changed, then saved as the dialog's Save does, everything else as it
   * stands: a row that cannot be applied here is left out and answered as `notApplied`. As the
   * dialog's tabs: only once sbx is ready (readySbx), and nothing but the switch while sandboxing
   * is off. A stored value stays with its row's name; a removed row's goes.
   */
  const editSbx = async (
    args: Record<string, unknown>,
    caller: ControlRequest["caller"],
    edit: (loaded: { config: SbxProjectConfig; knowledge: SbxKnowledgeConfig }) => {
      config?: SbxProjectConfig;
      knowledge?: SbxKnowledgeConfig;
    },
    switching = false
  ): Promise<Answer> => {
    const found = project(args, caller);
    const status = await readySbx(found);
    const config = await deps.sbx.config(found);
    const { knowledge } = deps.sbx.stored(found.id);
    if (!config.enabled && !switching) {
      throw new ControlError("bad_args", `SBX sandboxing is off for ${found.name}: sbx-set-enabled on first`);
    }
    const next = edit({ config, knowledge });
    const request = next.config ?? config;
    const nextKnowledge = next.knowledge ?? knowledge;
    const saved = await deps.sbx.save(
      found,
      request,
      { secrets: keptValues(request.secrets), variables: keptValues(request.variables), knowledge: nextKnowledge },
      status
    );
    if (!saved.ok) {
      throw new ControlError("internal", saved.error ?? "could not save the SBX Settings");
    }
    const problems = saved.problems ?? {};
    const applied = withoutProblems(request, nextKnowledge, problems);
    const restartRequired = sbxNeedsRestart(config, knowledge, applied.config, applied.knowledge);
    return { result: { saved: true, restartRequired, ...(Object.keys(problems).length > 0 ? { notApplied: problems } : {}) } };
  };

  /** Refuses the first variable that cannot be saved beside those before it and the secrets
   *  (sbxVariableRefusal), names compared as this machine does. */
  const refuseVariables = (variables: SbxVariable[], secrets: SbxSecret[]): void => {
    variables.forEach((variable, index) => {
      const refusal = sbxVariableRefusal(variable, variables.slice(0, index), secrets, process.platform === "win32");
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
    // Not a project's, but asked of one: its status carries the sign-in.
    "sbx-accounts": async (args, caller) => {
      const { loggedIn } = await deps.sbx.status(project(args, caller));
      const account = loggedIn ? await deps.sbx.signedInUser() : undefined;
      return {
        result: {
          signedIn: loggedIn,
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
      const [status, config] = await Promise.all([deps.sbx.status(found), deps.sbx.config(found)]);
      const problems = await deps.sbx.problems(found, config, stored.knowledge, stored, status);
      return { result: { status, config, stored, problems } };
    },

    "sbx-set-enabled": async (args, caller) => {
      const value = text(args, "value", "on or off");
      if (value !== "on" && value !== "off") {
        throw new ControlError("bad_args", `not on or off: ${value}`);
      }
      // As the dialog's switch, locked where no agent runs on this machine.
      if (value === "off" && !(await deps.sbx.anyAgentInstalled())) {
        throw new ControlError("bad_args", "no agent is installed on this machine, so sandboxing cannot be switched off");
      }
      return editSbx(args, caller, ({ config }) => ({ config: { ...config, enabled: value === "on" } }), true);
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
      return editSbx(args, caller, ({ config }) => ({ config: { ...config, ports } }));
    },

    "sbx-set-paths": (args, caller) => {
      const paths = list(args, "paths").map((entry) => {
        // The last colon: a Windows path has one of its own.
        const at = entry.lastIndexOf(":");
        const access = entry.slice(at + 1);
        if (at < 0 || (access !== "ro" && access !== "rw")) {
          throw new ControlError("bad_args", `not <path>:<ro|rw>: ${entry}`);
        }
        return { path: absolute(entry.slice(0, at)), access: access as SbxAccess };
      });
      return editSbx(args, caller, ({ config }) => ({ config: { ...config, paths } }));
    },

    "sbx-set-hosts": (args, caller) => {
      const hosts = list(args, "hosts")
        .map((host) => host.trim())
        .filter(Boolean);
      return editSbx(args, caller, ({ config }) => ({ config: { ...config, hosts } }));
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
      return editSbx(args, caller, ({ config }) => {
        refuseVariables(config.variables, secrets);
        return { config: { ...config, secrets } };
      });
    },

    "sbx-set-variables": (args, caller) => {
      const variables = list(args, "variables").map((name) => ({ env: name.trim() }));
      return editSbx(args, caller, ({ config }) => {
        refuseVariables(variables, config.secrets);
        return { config: { ...config, variables } };
      });
    },

    "sbx-set-knowledge": (args, caller) => {
      const kind = text(args, "kind", "kind");
      const access = text(args, "access", "off, ro or rw");
      if (!SBX_KNOWLEDGE_KINDS.some((candidate) => candidate === kind)) {
        throw new ControlError("bad_args", `unknown kind: ${kind} (one of ${SBX_KNOWLEDGE_KINDS.join(", ")})`);
      }
      if (access !== "off" && access !== "ro" && access !== "rw") {
        throw new ControlError("bad_args", `not off, ro or rw: ${access}`);
      }
      return editSbx(args, caller, ({ knowledge }) => ({
        knowledge: { ...knowledge, [kind as SbxKnowledgeKind]: access === "off" ? false : access }
      }));
    },

    "sbx-set-skills-folder": (args, caller) => {
      const folder = typeof args.path === "string" && args.path !== "" ? absolute(args.path) : undefined;
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
