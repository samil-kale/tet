const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const tsconfig = path.join(__dirname, "tsconfig.json");
const dist = path.join(__dirname, "dist");

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  tsconfig
};

/** @type {import('esbuild').BuildOptions} */
const mainConfig = {
  ...common,
  entryPoints: [path.join(__dirname, "src", "main", "main.ts")],
  outfile: path.join(dist, "main.js"),
  platform: "node",
  target: "node22",
  format: "cjs",
  // electron is provided by the runtime; node-pty is a native addon and cannot be bundled.
  external: ["electron", "node-pty"]
};

/** The git CLI wrapper, which runs in a utilityProcess of its own — see CLAUDE.md. */
/** @type {import('esbuild').BuildOptions} */
const gitHostConfig = {
  ...common,
  entryPoints: [path.join(__dirname, "src", "main", "git-host.ts")],
  outfile: path.join(dist, "git-host.js"),
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"]
};

/**
 * The `tet-ctl` CLI an agent runs from a terminal, under tet's own electron as node (see
 * src/main/control-launcher.ts) — plain node, nothing from electron in it.
 */
/** @type {import('esbuild').BuildOptions} */
const cliConfig = {
  ...common,
  entryPoints: [path.join(__dirname, "src", "cli", "tet-ctl.ts")],
  outfile: path.join(dist, "tet-ctl.js"),
  platform: "node",
  target: "node22",
  format: "cjs"
};

/** @type {import('esbuild').BuildOptions} */
const preloadConfig = {
  ...common,
  entryPoints: [path.join(__dirname, "src", "preload", "preload.ts")],
  outfile: path.join(dist, "preload.js"),
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"]
};

/** @type {import('esbuild').BuildOptions} */
const rendererConfig = {
  ...common,
  entryPoints: [path.join(__dirname, "src", "renderer", "main.tsx")],
  outfile: path.join(dist, "renderer.js"),
  platform: "browser",
  format: "iife",
  target: "chrome130",
  // monaco's CSS pulls in codicon.ttf; without a loader for it the build fails outright.
  loader: { ".ttf": "file" },
  // monaco reads `import.meta.url` as a worker-location fallback (unreached — see editor.ts's
  // `getWorker`); esbuild replaces `import.meta` with `{}` under `format: "iife"` and warns at
  // every such site, which would otherwise bury real warnings in noise.
  logOverride: { "empty-import-meta": "silent" }
};

/** The editor's own web worker (tokenization, etc. off the main thread) — see editor.ts. */
/** @type {import('esbuild').BuildOptions} */
const editorWorkerConfig = {
  ...common,
  entryPoints: [require.resolve("monaco-editor/editor/editor.worker.js")],
  outfile: path.join(dist, "editor.worker.js"),
  platform: "browser",
  format: "iife",
  target: "chrome130"
};

/**
 * The tests, for node's own runner (`npm test`): the control server with its dependencies
 * faked, driven through the built CLI — see test/control.test.ts. Bundled like the CLI, so a
 * test imports the source the way the app does, without a loader of its own.
 */
/** @type {import('esbuild').BuildOptions} */
const testConfig = {
  ...common,
  entryPoints: [path.join(__dirname, "test", "*.test.ts")],
  outdir: path.join(__dirname, "dist-test"),
  platform: "node",
  target: "node22",
  format: "cjs",
  // electron for its binary's path (app.test.ts starts it), node-pty because pty.ts imports it
  // and neither can be bundled — the first reads a file beside itself, the second is native.
  external: ["electron", "node-pty"]
};

function copyStaticAssets() {
  fs.mkdirSync(dist, { recursive: true });
  for (const file of ["index.html", "icon.png", "icon.ico"]) {
    fs.copyFileSync(path.join(__dirname, "src", "renderer", file), path.join(dist, file));
  }
}

async function build() {
  copyStaticAssets();

  const configs = [mainConfig, gitHostConfig, cliConfig, preloadConfig, rendererConfig, editorWorkerConfig, testConfig];
  if (watch) {
    const contexts = await Promise.all(configs.map((config) => esbuild.context(config)));
    await Promise.all(contexts.map((context) => context.watch()));
  } else {
    await Promise.all(configs.map((config) => esbuild.build(config)));
  }
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
