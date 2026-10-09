import * as fs from "node:fs";
import * as path from "node:path";
import { SANDBOX_HOME, SANDBOX_TARGET } from "../hook-target";
import { createByteThresholdCheck } from "../cli-ready";
import { codexIcon } from "./icon";
import type { SandboxedAgent } from "../agent";
import { hookSessionId } from "../hook-payload";
import { codexHookReply, setupCodexHooks } from "./hooks";
import { listModels } from "./app-server-client";
import { codexHome, codexSandboxSessions, codexSessionProvider } from "./sessions";

/**
 * `-c` overrides need Codex's embedded app server, not its shared background one: asked for
 * outright, it starts embedded without a startup warning.
 */
const BASE_ARGS = ["--no-daemon"];

export const codexAgent: SandboxedAgent = {
  id: "codex",
  displayName: "codex",
  icon: codexIcon,
  // Its input field is no shell: only a space needs quoting, in double quotes.
  quotePath: (filePath) => (/\s/.test(filePath) ? `"${filePath}"` : filePath),
  executable: () => "codex",
  install: { versionArgs: ["--version"], verifiedVersion: "0.159.2" },
  terminal: {
    // The positional prompt of an interactive session, after the `-c` options.
    initialPromptArgs: (prompt) => [prompt],
    // Above what setup and onboarding print before the first real redraw.
    createIsCliReady: () => createByteThresholdCheck(600),
    // One Ctrl+C clears a non-empty composer and quits on an empty one; a second byte would land
    // mid-shutdown, where ConPTY turns it into a CTRL_C_EVENT that kills the shutdown.
    quitPresses: 1,
    // ESC+CR, which its input reads as a newline rather than a submit.
    shiftEnter: "\x1b\r",
  },
  // `--ephemeral` writes no rollout, so no session is left behind.
  ask: {
    args: ["exec", "--ephemeral", "--skip-git-repo-check", "--color", "never"],
    models: listModels,
    modelArgs: (model) => ["--model", model],
  },
  sessions: codexSessionProvider,
  // See AgentTurns.questionOutlivesTurn.
  turns: { sessionIdOf: hookSessionId, questionOutlivesTurn: true, hookReply: codexHookReply },
  host: {
    // Nothing is written (setupCodexHooks), so nothing can fail.
    prepare: () => Promise.resolve({ args: [...BASE_ARGS, ...setupCodexHooks()] }),
  },
  sandbox: {
    prepare: () => ({ args: [...BASE_ARGS, ...setupCodexHooks(SANDBOX_TARGET)] }),
    // Skills in `~/.codex/skills` and `~/.agents/skills`; `~/.codex/AGENTS.md`, `AGENTS.override.md`
    // preferred. Under the config root the sessions are read from.
    knowledge: () => {
      const home = codexHome();
      const instructionsHost = [path.join(home, "AGENTS.override.md"), path.join(home, "AGENTS.md")].find((file) => fs.existsSync(file));
      return {
        skills: [{ host: path.join(home, "skills"), target: `${SANDBOX_HOME}/.codex/skills` }],
        instructions: instructionsHost ? [{ host: instructionsHost, target: `${SANDBOX_HOME}/.codex/AGENTS.md` }] : [],
      };
    },
    sharedSkillsTarget: `${SANDBOX_HOME}/.agents/skills`,
    sessions: codexSandboxSessions,
  },
};
