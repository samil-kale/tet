import * as fs from "node:fs";
import { builtinModules } from "node:module";
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

/** Each lane's own folder under src/renderer/lanes, read off the disk like AGENT_FOLDERS. */
const LANE_FOLDERS = fs
  .readdirSync(new URL("./src/renderer/lanes", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/** Every file of src/, for the rules that hold all of it. */
const SRC_FILES = ["src/**/*.{ts,tsx}"];
/** The two files where IPC's channels are wired: main's wrappers and the preload. */
const IPC_SITES = ["src/main/ipc/channels.ts", "src/preload/preload.ts"];

const IPC_MESSAGE = "Only through the typed wrappers: handle/on/once (ipc/channels.ts), invoke/send/subscribe (preload).";
/** By its name, or off electron's namespace; an alias is refused at its import (IPC_IMPORT). */
const IPC_BY_NAME = {
  selector: "MemberExpression:matches([object.name=/^ipc(Main|Renderer)$/], [property.name=/^ipc(Main|Renderer)$/])",
  message: IPC_MESSAGE
};
/** A message to a window, off its webContents or an event's sender, or either handed on to be sent through later. */
const WEB_CONTENTS_SEND = [
  "CallExpression[callee.property.name=/^(send|postMessage|sendToFrame)$/]:matches([callee.object.name=/^(webContents|sender)$/], [callee.object.property.name=/^(webContents|sender)$/])",
  ":not(MemberExpression) > MemberExpression[property.name=/^(webContents|sender)$/]"
].map((selector) => ({ selector, message: "Only through window.ts's typed send." }));
const PROCESS_PLATFORM = { object: "process", property: "platform", message: "Ask PLATFORM (util/host-platform.ts)." };
const NAVIGATOR_PLATFORM = ["platform", "userAgent", "userAgentData"].map((property) => ({
  object: "navigator",
  property,
  message: "Ask PLATFORM (renderer/platform.ts)."
}));
/** process.platform by another way: node:os's platform() under any name, or process off globalThis. */
const HOST_PLATFORM = [
  "ImportDeclaration[source.value=/^(node:)?os$/] > ImportSpecifier[imported.name='platform']",
  "CallExpression[callee.property.name='platform']",
  "MemberExpression[property.name='platform'][object.property.name='process']"
].map((selector) => ({ selector, message: PROCESS_PLATFORM.message }));
/** Every spawn goes through resolveCommand; a shell joins the arguments unescaped. An object is a namespace, never the option. */
const SHELL_OPTION = {
  selector: "Property:matches([key.name='shell'], [key.value='shell']):not([value.value=false]):not([value.type='ObjectExpression'])",
  message: "Never a `shell` option: spawn through resolveCommand (util/process.ts)."
};
/** net.fetch throws on a redirect it is told not to follow; net.request reads one. */
const REDIRECT_MANUAL = {
  selector: "CallExpression[callee.property.name='fetch'] > ObjectExpression > Property[key.name='redirect'][value.value='manual']",
  message: "net.fetch throws on `redirect: \"manual\"`: read the redirect with net.request."
};

/** An equality or a switch case against one of `values` (an esquery regex). */
const comparedWith = (values, message) => [
  { selector: `BinaryExpression[operator=/^[!=]==?$/]:matches([left.value=${values}], [right.value=${values}])`, message },
  { selector: `SwitchCase[test.value=${values}]`, message }
];
/** The platform's id is data alone: what differs between the OSes is a Platform member. */
const PLATFORM_ID = comparedWith("/^(win32|darwin|linux)$/", "The platform's id is data: branch on a Platform member (shared/platform.ts).");
/** No code outside agents/ names an agent but the shell, which TET itself runs saved commands and plain terminals in. */
const AGENT_ID = comparedWith(
  `/^(${AGENT_FOLDERS.filter((name) => name !== "shell").join("|")})$/`,
  "No code outside agents/ names an agent: whether it can do something is whether it has the group (agent.ts)."
);

/** Colors come from `--tet-*` variables, set by the themes alone. */
const COLOR = "/#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\\b|\\b(rgba?|hsla?)\\(/";
const COLOR_LITERAL = [`Literal[value=${COLOR}]`, `TemplateElement[value.raw=${COLOR}]`].map((selector) => ({
  selector,
  message: "Colors only from --tet-* variables (renderer/themes/)."
}));

/** A function, object or array literal handed to a component is new on every render: the views under App are memoized. */
const UNSTABLE_PROP = {
  selector:
    "JSXOpeningElement[name.name=/^[A-Z]/] > JSXAttribute > JSXExpressionContainer > :matches(ArrowFunctionExpression, FunctionExpression, ObjectExpression, ArrayExpression)",
  message: "A prop of a memoized view must be stable: useCallback, useMemo or a constant (identity.ts)."
};

/** What every file of src/ is held to by no-restricted-syntax; the configs below leave out what a file may do. */
const SRC_SYNTAX = [IPC_BY_NAME, ...WEB_CONTENTS_SEND, SHELL_OPTION, REDIRECT_MANUAL, ...HOST_PLATFORM, ...PLATFORM_ID, ...AGENT_ID];
const syntaxWithout = (...allowed) => ["error", ...SRC_SYNTAX.filter((entry) => !allowed.flat().includes(entry))];

/** exec and execSync run their command through a shell, which joins the arguments unescaped. */
const SHELL_EXEC = ["child_process", "node:child_process"].map((name) => ({
  name,
  importNames: ["exec", "execSync"],
  message: "Always through a shell: spawn through resolveCommand (util/process.ts)."
}));
/** Starting a process; a type (`ChildProcess`, `IPty`) is no spawn. */
const SPAWNS = [
  ...["child_process", "node:child_process"].map((name) => ({
    name,
    importNames: ["spawn", "spawnSync", "execFile", "execFileSync", "fork"],
    allowTypeImports: true,
    message: "Spawn through util/process.ts (resolveCommand, runProcess); a new spawn site joins SPAWN_SITES."
  })),
  {
    name: "node-pty",
    allowTypeImports: true,
    message: "A tab's pty is spawned by terminals/pty.ts; a new spawn site joins SPAWN_SITES."
  }
];
/** IPC's own objects; a type (`IpcMainEvent`) is no channel. */
const IPC_IMPORT = {
  name: "electron",
  importNames: ["ipcMain", "ipcRenderer", "webContents"],
  allowTypeImports: true,
  message: IPC_MESSAGE
};
/** What every file of src/ is held to by @typescript-eslint/no-restricted-imports; the configs below leave out what a file may do. */
const SRC_IMPORTS = [...SHELL_EXEC, ...SPAWNS, IPC_IMPORT];
const importsWithout = (...allowed) => ["error", { paths: SRC_IMPORTS.filter((entry) => !allowed.flat().includes(entry)) }];
/** The files that start a process themselves, each for its reason: a new one is a decision, not a drift. */
const SPAWN_SITES = [
  // resolveCommand itself, and runProcess and killProcessTree on top of it.
  "src/main/util/process.ts",
  // A tab's pty, from resolveCommand.
  "src/main/terminals/pty.ts",
  // git in its utility process, which reaches nothing of util/ but linked-git-dir.
  "src/main/git/git.ts",
  // The login shell asked for the PATH that resolveCommand looks up in, by its absolute path.
  "src/main/agents/agent-path.ts",
  // Codex's app server, from resolveCommand, held open over stdio.
  "src/main/agents/codex/app-server-client.ts",
  // The updater: the new binary by its absolute path, detached to outlive tet.
  "src/main/update/auto-update.ts"
];

/** The window runs in Chromium: node is main's, reached through TETApi. */
const NODE_BUILTIN = {
  regex: `^(node:|(${builtinModules.filter((name) => !name.includes(":")).join("|")})(/|$))`,
  message: "The renderer runs without node: ask main through TETApi."
};

/** Every question is Dialog.tsx's confirm or prompt, asked by the view offering the action. */
const NATIVE_DIALOGS = [
  // Off any object: electron's dialog is reached under any name.
  ...["showMessageBox", "showMessageBoxSync", "showErrorBox"].map((property) => ({ property })),
  ...["window", "globalThis", "self"].flatMap((object) => ["alert", "confirm", "prompt"].map((property) => ({ object, property })))
].map((entry) => ({ ...entry, message: "No native message boxes: ask with Dialog.tsx's confirm or prompt, in the window." }));

/** Only Chromium's stack applies the machine's proxy and certificate store: the global fetch off a global object. */
const GLOBAL_FETCH = ["globalThis", "window", "self"].map((object) => ({
  object,
  property: "fetch",
  message: "Use electron's net.fetch (or net.request to read a redirect)."
}));
/** node's https, beside electron's net; node:http stays for the control channel on localhost. */
const NODE_HTTPS = { regex: "^(node:)?https$", message: "Use electron's net.fetch (or net.request to read a redirect)." };

/** What every file of src/ is held to by no-restricted-properties; the configs below leave out what a file may do. */
const SRC_PROPERTIES = [PROCESS_PLATFORM, ...NAVIGATOR_PLATFORM, ...NATIVE_DIALOGS, ...GLOBAL_FETCH];
const propertiesWithout = (...allowed) => ["error", ...SRC_PROPERTIES.filter((entry) => !allowed.flat().includes(entry))];

/**
 * The way up out of a folder of `process`, and back down into it past its own name (`../../main/x`
 * from main, `../../../src/main/x`): an area is the same whichever way it is reached. The name is
 * always passed, never read as an area itself (main's `main.ts`).
 */
const upInto = (process) => `^(\\.{1,2}/)+((src/)?${process}/|(?!(src/)?${process}/))`;

/**
 * Shared code reaches an agent through the registry, never its own folder (AGENTS.md); inside
 * agents/ that folder lies beside the importer (`./claude`), or beside its own (`../codex`).
 */
const agentFolder = (area) => ({
  regex: `${upInto("main")}${area === "agents" ? "(agents/)?" : "agents/"}(${AGENT_FOLDERS.join("|")})(/|$)`,
  message: "An agent's own folder; go through the registry (agents/index.ts) or agent.ts."
});

/**
 * A lane imports no other lane: what two of them share lies below them (`git/run-action.ts`). The
 * other lane lies beside the importer's own (`../files`), or is reached through lanes/
 * (`../../lanes/files`); `../../git` is the shared git/, not a lane.
 */
const LANE_FOLDER = {
  regex: `^(\\.\\./|(\\.\\./)+((src/)?renderer/)?lanes/)(${LANE_FOLDERS.join("|")})(/|$)`,
  message: "Another lane's own folder; what two lanes share lies below them (git/, ui/)."
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
  { ctl: [] },
  { ipc: ["*"], main: ["*"], window: ["*"], projects: ["*"], requirements: ["*"], uncaught: ["*"] }
];

const RENDERER_LAYERS = [
  { platform: ["*"], paths: ["*"], identity: ["*"], "resolved-ref": ["*"], shortcuts: ["*"], themes: ["*"] },
  { ui: [] },
  { editor: [] },
  { tabs: [] },
  { git: [] },
  { lanes: [], dialogs: [] },
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

/** An area's process border and every area of its process it may not reach. */
function layerPatterns(process, layers, area) {
  const index = layers.findIndex((layer) => area in layer);
  const layer = layers[index];
  const beside = layer[area];
  const above = layers.slice(index + 1).flatMap((higher) => Object.keys(higher));
  const sideways = beside.includes("*") ? [] : Object.keys(layer).filter((other) => other !== area && !beside.includes(other));
  const barred = [...above, ...sideways];
  return [
    processBorder(process),
    ...(barred.length === 0
      ? []
      : [
          {
            // A flat area is the same file with its extension written out (`../window.js`).
            regex: `${upInto(process)}(${barred.join("|")})(\\.[jt]sx?)?(/|$)`,
            message: `${area} may not import this area: only its own layer's allowed ones and those below (AGENTS.md, "Where things live").`
          }
        ])
  ];
}

/** One config per area of the process: its layer patterns and `extra`. */
function layerConfigs(process, layers, extra = () => []) {
  return layers.flatMap((layer) =>
    Object.keys(layer).map((area) => {
      const folder = fs.existsSync(new URL(`./src/${process}/${area}`, import.meta.url));
      return {
        files: [folder ? `src/${process}/${area}/**` : `src/${process}/${area}.{ts,tsx}`],
        rules: {
          "no-restricted-imports": ["error", { patterns: [...layerPatterns(process, layers, area), ...extra(area)] }]
        }
      };
    })
  );
}

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/dist-test/**", "**/node_modules/**"]
  },
  // A disable comment that no longer silences anything is a lint error, not a warning.
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Rules that need types: a promise nobody awaits swallows its error, an `any` crossing JSON
  // or IPC reaches the code unchecked.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: ["**/*.{ts,tsx}"] })),
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // node:test's test(), describe() and the like return a promise the runner itself awaits.
      "@typescript-eslint/no-floating-promises": [
        "error",
        { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "describe", "it", "suite"] }] }
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true, ignoreVoidOperator: true }],
      "@typescript-eslint/no-use-before-define": ["error", { functions: false, classes: false, variables: false, typedefs: false }],
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/prefer-includes": "error",
      "@typescript-eslint/prefer-string-starts-ends-with": "error",
      "@typescript-eslint/no-unnecessary-type-conversion": "error",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
      "@typescript-eslint/non-nullable-type-assertion-style": "error",
      "@typescript-eslint/no-unnecessary-boolean-literal-compare": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true }],
      "no-multi-assign": "error",
      curly: "error",
      // `== null` is the one deliberate loose comparison: null and undefined alike.
      eqeqeq: ["error", "always", { null: "ignore" }],
      // typeof import("./git") types the utility process's module without loading it into main.
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports", disallowTypeAnnotations: false }],
      "@typescript-eslint/no-import-type-side-effects": "error"
    }
  },
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
  ...layerConfigs("main", MAIN_LAYERS, (area) => [agentFolder(area), NODE_HTTPS]),
  // The registry is the one file naming the agents' folders.
  {
    files: ["src/main/agents/index.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [...layerPatterns("main", MAIN_LAYERS, "agents"), NODE_HTTPS] }] }
  },
  ...layerConfigs("renderer", RENDERER_LAYERS, (area) => [NODE_BUILTIN, ...(area === "lanes" ? [LANE_FOLDER] : [])]),
  {
    // The utility processes (git-host.ts, explorer-host.ts) and the CLI run without electron;
    // `shared/` runs in every process. None of them may import it, and the utility processes may
    // import nothing from the rest of main either but the util/ files listed here, each held to the
    // same — util/utility-client.ts is the main-process side of that boundary.
    files: [
      "src/main/git/git.ts",
      "src/main/git/git-host.ts",
      "src/main/git/explorer-read.ts",
      "src/main/git/explorer-host.ts",
      "src/main/util/linked-git-dir.ts",
      "src/main/util/host-platform.ts",
      "src/main/util/utility-host.ts",
      "src/cli/**",
      "src/shared/**"
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "electron", message: "Runs outside electron's main process." }],
          patterns: [
            // A regex, since glob negation does not take a `..` segment: anything one or two
            // levels up that is not `shared`, or one of the util/ files above.
            {
              regex: "^\\.\\./(?!shared(/|$))(?!\\.\\./shared(/|$))(?!util/(linked-git-dir|host-platform|utility-host)$)",
              message: "Only src/shared, this folder and util/'s linked-git-dir, host-platform and utility-host."
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
  // Every spawn goes through resolveCommand (AGENTS.md, "Cross-platform"): the files starting a
  // process are listed, and none runs a shell. typescript-eslint's rule, not the layers' own, so an
  // allowed spawn site keeps its layer's imports and a type import passes.
  {
    files: SRC_FILES,
    rules: { "@typescript-eslint/no-restricted-imports": importsWithout() }
  },
  { files: SPAWN_SITES, rules: { "@typescript-eslint/no-restricted-imports": importsWithout(SPAWNS) } },
  // Every IPC channel goes through its typed wrappers (AGENTS.md, "Where things live"): a bare call
  // with a string would leave main and the preload free to drift apart unnoticed. The platform's id
  // is compared only where the Platform is picked, an agent's only in agents/ (AGENTS.md,
  // "Cross-platform", "Where things live"), and the renderer's colors come from the themes alone
  // (AGENTS.md, "Look").
  {
    files: IPC_SITES,
    rules: { "@typescript-eslint/no-restricted-imports": importsWithout(IPC_IMPORT) }
  },
  { files: SRC_FILES, rules: { "no-restricted-syntax": syntaxWithout() } },
  { files: IPC_SITES, rules: { "no-restricted-syntax": syntaxWithout(IPC_BY_NAME) } },
  { files: ["src/main/window.ts"], rules: { "no-restricted-syntax": syntaxWithout(WEB_CONTENTS_SEND) } },
  { files: ["src/main/util/host-platform.ts"], rules: { "no-restricted-syntax": syntaxWithout(HOST_PLATFORM) } },
  { files: ["src/main/agents/**"], rules: { "no-restricted-syntax": syntaxWithout(AGENT_ID) } },
  { files: ["src/shared/platform.ts"], rules: { "no-restricted-syntax": syntaxWithout(PLATFORM_ID) } },
  { files: ["src/renderer/**/*.{ts,tsx}"], rules: { "no-restricted-syntax": [...syntaxWithout(), ...COLOR_LITERAL] } },
  { files: ["src/renderer/themes/**"], rules: { "no-restricted-syntax": syntaxWithout() } },
  // The views under App are memoized (AGENTS.md, "UI rules"): App hands them stable props alone.
  { files: ["src/renderer/App.tsx"], rules: { "no-restricted-syntax": [...syntaxWithout(), ...COLOR_LITERAL, UNSTABLE_PROP] } },
  // What differs between the OSes is a Platform member; only the two files naming the platform ask
  // which one it is (AGENTS.md, "Cross-platform"). No native message boxes (AGENTS.md, "UI rules").
  // The fetch off a global object is main's alone to refuse, as the global itself (below).
  { files: SRC_FILES, rules: { "no-restricted-properties": propertiesWithout(GLOBAL_FETCH) } },
  { files: ["src/main/**/*.{ts,tsx}"], rules: { "no-restricted-properties": propertiesWithout() } },
  { files: ["src/main/util/host-platform.ts"], rules: { "no-restricted-properties": propertiesWithout(PROCESS_PLATFORM) } },
  { files: ["src/renderer/platform.ts"], rules: { "no-restricted-properties": propertiesWithout(NAVIGATOR_PLATFORM, GLOBAL_FETCH) } },
  // The tests ask the same Platform members; testing each OS's own installer, install.test.ts alone
  // branches on the id.
  {
    files: ["test/**/*.ts"],
    ignores: ["test/e2e/install.test.ts"],
    rules: {
      "no-restricted-properties": ["error", PROCESS_PLATFORM, ...NAVIGATOR_PLATFORM],
      "no-restricted-syntax": ["error", ...HOST_PLATFORM, ...PLATFORM_ID]
    }
  },
  // Only Chromium's stack applies the machine's proxy and certificate store (AGENTS.md,
  // "Cross-platform"); node's https is refused among main's layers.
  {
    files: ["src/main/**"],
    rules: {
      "no-restricted-globals": ["error", { name: "fetch", message: "Use electron's net.fetch (or net.request to read a redirect)." }]
    }
  },
  // A test's stub is async to fit the interface it stands in for.
  { files: ["test/**/*.ts"], rules: { "@typescript-eslint/require-await": "off" } },
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
    files: ["**/esbuild.js", "scripts/*.js", "test/helpers/electron-stub.js"],
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
