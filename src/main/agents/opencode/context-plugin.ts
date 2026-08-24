import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Passing the context to opencode. Unlike Claude Code, opencode has no declarative hook
 * file — the only way into a message being composed is a plugin (a .ts file under a
 * `plugins/` directory) hooking `chat.message`, and the HTTP API has no equivalent.
 *
 * `OPENCODE_CONFIG_DIR` points opencode at tet's own install dir additively: it does not
 * replace the user's `.opencode/plugins/` or `~/.config/opencode/plugins/`. Set on the server
 * process rather than on the terminal, since under `attach` the TUI is only a client and the
 * server is what loads plugins. Nothing here touches the repository or the user's own config.
 *
 * The install dir is shared across repositories, not per repository: opencode bun-installs
 * `@opencode-ai/plugin` and its transitive dependencies the first time it sees a plugins/
 * file in a config dir it doesn't recognise, which takes seconds to minutes. Scoping that
 * per repository would make every new project pay the cost again; one shared dir pays it
 * once per machine.
 */
function opencodePluginsDir(storageRoot: string): string {
  return path.join(storageRoot, "opencode-plugins");
}

/** Set on the server so the generated plugin can tell whose repository it is serving. */
const PROJECT_ROOT_ENV = "TET_PROJECT_ROOT";

/**
 * Writes this repository's context plugin into the shared plugins directory and returns the
 * environment the server needs to load and scope it.
 */
export function installContextPlugin(storageRoot: string, cwd: string, contextFile: string): Record<string, string> {
  const installDir = opencodePluginsDir(storageRoot);
  const pluginsDir = path.join(installDir, "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });

  // Repository-unique name: the plugins/ dir is shared across all of them, so each one's
  // generated plugin needs its own file to avoid colliding with another's.
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const pluginFile = path.join(pluginsDir, `context-${hash}.ts`);
  const contents = `import { readFileSync } from "node:fs";

// The plugins/ dir is shared across repositories (see file header), so each repository's
// server loads every repository's generated plugin, not just its own. ${PROJECT_ROOT_ENV} is
// set on that server process; without this guard a message would get every other open
// repository's context appended too.
const PROJECT_ROOT = ${JSON.stringify(cwd)};

export const TETContextPlugin = async () => {
  return {
    "chat.message": async (input, output) => {
      if (process.env.${PROJECT_ROOT_ENV} !== PROJECT_ROOT) return;
      try {
        let text = readFileSync(${JSON.stringify(contextFile)}, "utf8");
        if (text.charCodeAt(0) === 0xfeff) {
          text = text.slice(1);
        }
        if (text.trim().length > 0) {
          output.parts.push({
            id: "prt_" + crypto.randomUUID().replace(/-/g, ""),
            sessionID: output.message.sessionID,
            messageID: output.message.id,
            type: "text",
            text,
            synthetic: true
          });
        }
      } catch {
        // Nothing run in a shell yet — skip silently.
      }
    }
  };
};
`;

  // opencode pays a large one-time cost (minutes, per sbc's measurements) to recompile a
  // plugin whenever its file changes — skip the write when the content already matches, so
  // restarting tet doesn't retrigger that every time.
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(pluginFile, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing !== contents) {
    fs.writeFileSync(pluginFile, contents);
  }

  return { OPENCODE_CONFIG_DIR: installDir, [PROJECT_ROOT_ENV]: cwd };
}
