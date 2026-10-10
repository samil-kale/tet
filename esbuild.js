const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
// Only `npm test` and `npm run dist` (whose archives CI install-tests) run the tests: a start or a
// watch would rebundle every test file for nothing.
const tests = process.argv.includes("--tests");
const tsconfig = path.join(__dirname, "tsconfig.json");
const dist = path.join(__dirname, "dist");
const distTest = path.join(__dirname, "dist-test");

// esbuild only bundles, it never typechecks: an unimported identifier becomes a global and the app
// dies on load with a ReferenceError. Hence `npm start` runs the typecheck first.
const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  tsconfig
};

/** Everything electron's node runs: main, the git host, preload, the CLIs, the tests. */
const node = { ...common, platform: "node", target: "node22", format: "cjs" };

/** The window's two bundles. */
const browser = { ...common, platform: "browser", format: "iife", target: "chrome130" };

/** @type {import('esbuild').BuildOptions} */
const mainConfig = {
  ...node,
  entryPoints: [path.join(__dirname, "src", "main", "main.ts")],
  outfile: path.join(dist, "main.js"),
  // electron (and its original-fs) is provided by the runtime; node-pty is a native addon and
  // cannot be bundled.
  external: ["electron", "original-fs", "node-pty"]
};

/** A module for a utilityProcess: git's CLI wrapper or the Explorer's walk and search.
 *  These modules run without electron (eslint.config.mjs). */
/** @returns {import('esbuild').BuildOptions} */
function hostConfig(folder, name) {
  return {
    ...node,
    entryPoints: [path.join(__dirname, "src", "main", folder, `${name}-host.ts`)],
    outfile: path.join(dist, `${name}-host.js`)
  };
}

/** The scripts under src/cli, each bundled on its own for plain node, nothing from electron in
 *  them: `tet-ctl`, which an agent runs from a terminal (see src/main/ctl/ctl-launcher.ts), and
 *  `tet-update`, which a new version's binary runs once tet has quit
 *  (src/main/update/auto-update.ts), each under tet's own electron as node. */
/** @returns {import('esbuild').BuildOptions} */
function cliConfig(name) {
  return {
    ...node,
    entryPoints: [path.join(__dirname, "src", "cli", `${name}.ts`)],
    outfile: path.join(dist, `${name}.js`)
  };
}

/** The window's preload under src/preload. */
/** @returns {import('esbuild').BuildOptions} */
function preloadConfig(name) {
  return {
    ...node,
    entryPoints: [path.join(__dirname, "src", "preload", `${name}.ts`)],
    outfile: path.join(dist, `${name}.js`),
    external: ["electron"]
  };
}

/** @type {import('esbuild').BuildOptions} */
const rendererConfig = {
  ...browser,
  entryPoints: [path.join(__dirname, "src", "renderer", "main.tsx")],
  outfile: path.join(dist, "renderer.js"),
  // monaco's CSS pulls in codicon.ttf, and styles.css the Explorer's seti.woff and the app's fonts;
  // without a loader for them the build fails outright.
  loader: { ".ttf": "file", ".woff": "file", ".woff2": "file" },
  // monaco reads `import.meta.url` as a worker-location fallback (unreached, see editor.ts's
  // `getWorker`); esbuild replaces `import.meta` with `{}` under `format: "iife"` and warns at
  // every such site, burying real warnings.
  logOverride: { "empty-import-meta": "silent" }
};

/** The editor's own web worker (tokenization, etc. off the main thread) — see editor.ts. */
/** @type {import('esbuild').BuildOptions} */
const editorWorkerConfig = {
  ...browser,
  entryPoints: [require.resolve("monaco-editor/editor/editor.worker.js")],
  outfile: path.join(dist, "editor.worker.js")
};

/** The tests, for node's own runner (`npm test`). Bundled like the CLI, so a test imports the
 *  source the way the app does, without a loader of its own. */
/** @type {import('esbuild').BuildOptions} */
const testConfig = {
  ...node,
  // test/ mirrors src/ (main/, renderer/, shared/) plus e2e/, and dist-test/ mirrors test/.
  entryPoints: [path.join(__dirname, "test", "**", "*.test.ts")],
  outbase: path.join(__dirname, "test"),
  outdir: distTest,
  // node-pty (native) cannot be bundled; esbuild finds its own binary relative to its package, and
  // main/agents.test.ts compiles pi's generated extension with it. electron is a stub: node's runner
  // has none (helpers/ finds the binary through its own require).
  alias: { electron: "./test/helpers/electron-stub.js" },
  external: ["node-pty", "esbuild"]
};

function copyStaticAssets() {
  fs.mkdirSync(dist, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "src", "renderer", "index.html"), path.join(dist, "index.html"));
  for (const file of ["icon.png", "icon.ico"]) {
    fs.copyFileSync(path.join(__dirname, "src", "renderer", "assets", file), path.join(dist, file));
  }
  // The OFL lets the fonts ship only with their license.
  for (const file of ["Inter-OFL.txt", "JetBrainsMono-OFL.txt"]) {
    fs.copyFileSync(path.join(__dirname, "src", "renderer", "assets", "fonts", file), path.join(dist, file));
  }
}

async function build() {
  // What electron-builder packages is dist/ whole (electron-builder.yml's `files`), so a production
  // build must not carry a development build's source maps along.
  if (production) {
    fs.rmSync(dist, { recursive: true, force: true });
  }
  // `npm test` runs every file in dist-test/, so a test deleted or renamed in test/ must not keep
  // running from its old build.
  if (tests) {
    fs.rmSync(distTest, { recursive: true, force: true });
  }
  copyStaticAssets();

  const configs = [
    mainConfig,
    hostConfig("git", "git"),
    hostConfig("git", "explorer"),
    cliConfig("tet-ctl"),
    cliConfig("tet-update"),
    preloadConfig("preload"),
    rendererConfig,
    editorWorkerConfig,
    ...(tests ? [testConfig] : [])
  ];
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
