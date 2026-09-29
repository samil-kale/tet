import * as fs from "node:fs";
import { URL } from "node:url";
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const PROCESSES = ["main", "renderer", "preload", "cli"];

/** Each agent's own folder under src/main/agents, read off the disk so a new agent needs nothing here. */
const AGENT_FOLDERS = fs
  .readdirSync(new URL("./src/main/agents", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const IPC_BY_NAME = {
  selector: "MemberExpression[object.name=/^ipc(Main|Renderer)$/]",
  message: "Only through the typed wrappers: handle/on/once (ipc/channels.ts), invoke/send/subscribe (preload)."
};
const WEB_CONTENTS_SEND = {
  selector: "CallExpression[callee.property.name='send'][callee.object.property.name='webContents']",
  message: "Only through window.ts's typed send."
};
const PROCESS_PLATFORM = { object: "process", property: "platform", message: "Ask PLATFORM (util/host-platform.ts)." };
const NAVIGATOR_PLATFORM = { object: "navigator", property: "platform", message: "Ask PLATFORM (renderer/platform.ts)." };
/** Every spawn goes through resolveCommand; a shell joins the arguments unescaped. */
const SHELL_TRUE = {
  selector: "Property[key.name='shell'][value.value=true]",
  message: "Never `shell: true`: spawn through resolveCommand (util/process.ts)."
};
/** Every question is Dialog.tsx's confirm or prompt, asked by the view offering the action. */
const NATIVE_DIALOGS = [
  ...["showMessageBox", "showMessageBoxSync", "showErrorBox"].map((property) => ({ object: "dialog", property })),
  ...["alert", "confirm", "prompt"].map((property) => ({ object: "window", property }))
].map((entry) => ({ ...entry, message: "No native message boxes: ask with Dialog.tsx's confirm or prompt, in the window." }));

/** Shared code reaches an agent through the registry, never its own folder (AGENTS.md). */
const agentFolder = {
  regex: `^(\\.{1,2}/)+agents/(${AGENT_FOLDERS.join("|")})(/|$)`,
  message: "An agent's own folder; go through the registry (agents/index.ts) or agent.ts."
};

/** Up and into another process's folder; a file of that name nearby (opencode's `./cli`) is not one. */
const processBorder = (folder) => ({
  regex: `^(\\.\\./)+(${PROCESSES.filter((other) => other !== folder).join("|")})(/|$)`,
  message: "Another process's code; go through src/shared."
});

/**
 * A process's layers, bottom first (AGENTS.md, "Where things live"): each area imports its own
 * layer's areas it lists beside it ("*" for all), and every layer below — never one above. An area
 * is a folder, or a flat file named without its extension.
 */
const MAIN_LAYERS = [
  { util: [] },
  { store: ["*"] },
  { git: [], agents: [], sbx: ["agents"], providers: [], update: [] },
  { terminals: [] },
  { control: [] },
  { ipc: ["*"], main: ["*"], window: ["*"], projects: ["*"], requirements: ["*"], uncaught: ["*"] }
];

const RENDERER_LAYERS = [
  { platform: ["*"], paths: ["*"], identity: ["*"], "resolved-ref": ["*"], shortcuts: ["*"], themes: ["*"] },
  { ui: [] },
  { editor: [] },
  { tabs: [] },
  { git: [] },
  { files: [], sidebar: [], dialogs: [] },
  { App: ["*"], Startup: ["*"], main: ["*"], "use-ref-feeds": ["*"] }
];

/**
 * Every folder and flat file of a process holding code is an area of its layers: one left out would
 * be held to nothing but the process border.
 */
function assertLayered(process, layers) {
  const listed = new Set(layers.flatMap((layer) => Object.keys(layer)));
  const root = new URL(`./src/${process}/`, import.meta.url);
  const holdsCode = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true, recursive: true }).some((entry) => entry.isFile() && /\.tsx?$/.test(entry.name));
  const areas = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory() ? holdsCode(new URL(`${entry.name}/`, root)) : /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")
    )
    .map((entry) => entry.name.replace(/\.tsx?$/, ""));
  const missing = areas.filter((area) => !listed.has(area));
  if (missing.length > 0) {
    throw new Error(`src/${process}: ${missing.join(", ")} in no layer (eslint.config.mjs)`);
  }
}
assertLayered("main", MAIN_LAYERS);
assertLayered("renderer", RENDERER_LAYERS);

/** One config per area of the process: its border, `extra`, and every area it may not reach. */
function layerConfigs(process, layers, extra = () => []) {
  return layers.flatMap((layer, index) =>
    Object.entries(layer).map(([area, beside]) => {
      const above = layers.slice(index + 1).flatMap((higher) => Object.keys(higher));
      const sideways = beside.includes("*") ? [] : Object.keys(layer).filter((other) => other !== area && !beside.includes(other));
      const barred = [...above, ...sideways];
      const folder = fs.existsSync(new URL(`./src/${process}/${area}`, import.meta.url));
      return {
        files: [folder ? `src/${process}/${area}/**` : `src/${process}/${area}.{ts,tsx}`],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                processBorder(process),
                ...extra(area),
                ...(barred.length === 0
                  ? []
                  : [
                      {
                        regex: `^(\\.{1,2}/)+(${barred.join("|")})(/|$)`,
                        message: `${area} may not import this area: only its own layer's allowed ones and those below (AGENTS.md, "Where things live").`
                      }
                    ])
              ]
            }
          ]
        }
      };
    })
  );
}

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/dist-test/**", "**/node_modules/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // The renderer's views are memoized and the terminals live outside React (AGENTS.md, "UI rules"),
  // so a stale closure or a dependency too many is a wrong screen, not a slow one — and every
  // "read it from a ref instead" here is deliberate. The rules keep those decisions honest.
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error"
    }
  },
  // The process borders, as lint rules rather than prose (see "Where things live" in AGENTS.md):
  // each folder under src/ is one process, and `shared/` the only thing they may import from one
  // another. main's and the renderer's are in each of their areas' configs below.
  ...["preload", "cli", "shared"].map((folder) => ({
    files: [`src/${folder}/**`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [processBorder(folder)]
        }
      ]
    }
  })),
  // The layers of src/main and src/renderer, each area's config repeating the process border: a
  // later config's rule replaces an earlier one's for the same file.
  ...layerConfigs("main", MAIN_LAYERS, (area) => (area === "agents" ? [] : [agentFolder])),
  ...layerConfigs("renderer", RENDERER_LAYERS),
  {
    // The git utility process (git-host.ts) and the CLI run without electron; `shared/` runs in
    // every process. None of them may import it, and the first two may import nothing from the
    // rest of main either but linked-git-dir.ts, itself held to the same — git-client.ts is the
    // main-process side of that boundary.
    files: ["src/main/git/git.ts", "src/main/git/git-host.ts", "src/main/util/linked-git-dir.ts", "src/cli/**", "src/shared/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "electron", message: "Runs outside electron's main process." }],
          patterns: [
            // A regex, since glob negation does not take a `..` segment: anything one or two
            // levels up that is not `shared`, or git.ts's linked-git-dir.
            {
              regex: "^\\.\\./(?!shared(/|$))(?!\\.\\./shared(/|$))(?!util/linked-git-dir$)",
              message: "Only src/shared, this folder and util/linked-git-dir."
            }
          ]
        }
      ]
    }
  },
  {
    // A folder of shared/ (types/) reaches the rest of shared/, and nothing beyond it.
    files: ["src/shared/*/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "electron", message: "Runs outside electron's main process." }],
          patterns: [{ regex: "^\\.\\./\\.\\./", message: "Only src/shared." }]
        }
      ]
    }
  },
  // Every IPC channel goes through its typed wrappers (AGENTS.md, "Where things live"): a bare call
  // with a string would leave main and the preload free to drift apart unnoticed.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", IPC_BY_NAME, WEB_CONTENTS_SEND, SHELL_TRUE] }
  },
  {
    files: ["src/main/ipc/channels.ts", "src/preload/preload.ts"],
    rules: { "no-restricted-syntax": ["error", WEB_CONTENTS_SEND, SHELL_TRUE] }
  },
  { files: ["src/main/window.ts"], rules: { "no-restricted-syntax": ["error", IPC_BY_NAME, SHELL_TRUE] } },
  // What differs between the OSes is a Platform member; only the two files naming the platform ask
  // which one it is (AGENTS.md, "Cross-platform"). No native message boxes (AGENTS.md, "UI rules").
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: { "no-restricted-properties": ["error", PROCESS_PLATFORM, NAVIGATOR_PLATFORM, ...NATIVE_DIALOGS] }
  },
  {
    files: ["src/main/util/host-platform.ts"],
    rules: { "no-restricted-properties": ["error", NAVIGATOR_PLATFORM, ...NATIVE_DIALOGS] }
  },
  { files: ["src/renderer/platform.ts"], rules: { "no-restricted-properties": ["error", PROCESS_PLATFORM, ...NATIVE_DIALOGS] } },
  // Only Chromium's stack applies the machine's proxy and certificate store (AGENTS.md,
  // "Cross-platform").
  {
    files: ["src/main/**"],
    rules: {
      "no-restricted-globals": ["error", { name: "fetch", message: "Use electron's net.fetch (or net.request to read a redirect)." }]
    }
  },
  {
    files: ["src/renderer/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["alert", "confirm", "prompt"].map((name) => ({ name, message: "Import Dialog.tsx's confirm or prompt." }))
      ]
    }
  },
  {
    files: ["**/esbuild.js", "scripts/*.js", "test/electron-stub.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        __dirname: "readonly",
        process: "readonly",
        console: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off"
    }
  }
);
